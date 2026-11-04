import { basename } from 'node:path';
import { config } from '../config.js';
import { pool } from '../db/index.js';
import { createLinearIssueAttachment, uploadLinearFile } from './linear.js';
import { downloadWhatsappMedia } from './whatsapp-media.js';

type EvidenceKind = 'audio' | 'video' | 'media';

interface DemandMediaRow {
  demand_id: number;
  message_id: number;
  linear_asset_url: string | null;
  kind: EvidenceKind;
  media: Record<string, unknown>;
  audio_base64: string | null;
  video_base64: string | null;
  media_base64: string | null;
  sent_at: Date;
  sender_jid: string;
  sender_name: string;
  from_me: boolean;
  provider: 'evolution' | 'waha';
  instance: string;
};

function limitFor(kind: EvidenceKind): number {
  if (kind === 'audio') return config.maxAudioBytes;
  if (kind === 'video') return config.maxVideoBytes;
  return config.maxMediaBytes;
}

function storedBytes(row: DemandMediaRow): Buffer | null {
  const value = row.kind === 'audio' ? row.audio_base64
    : row.kind === 'video' ? row.video_base64
      : row.media_base64;
  if (!value) return null;
  const bytes = Buffer.from(value.replace(/\s/g, ''), 'base64');
  if (!bytes.length) throw new Error('A mídia armazenada está vazia');
  if (bytes.length > limitFor(row.kind)) throw new Error('A mídia excede o limite configurado');
  return bytes;
}

function contentTypeFor(row: DemandMediaRow): string {
  const mime = typeof row.media.mimetype === 'string' ? row.media.mimetype.toLowerCase().trim() : '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}

function filenameFor(row: DemandMediaRow, contentType: string): string {
  const raw = typeof row.media.fileName === 'string' ? row.media.fileName
    : typeof row.media.filename === 'string' ? row.media.filename : '';
  const safe = basename(raw).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '').slice(0, 100);
  if (safe && safe !== '_') return safe;
  const extension = contentType.split('/')[1]?.replace(/[^a-z0-9.+-]/g, '') || 'bin';
  return `whatsapp-${row.kind}-${row.message_id}.${extension}`;
}

async function persistBytes(row: DemandMediaRow, bytes: Buffer): Promise<void> {
  const column = row.kind === 'audio' ? 'audio_base64'
    : row.kind === 'video' ? 'video_base64'
      : 'media_base64';
  await pool.query(
    `UPDATE messages SET ${column} = COALESCE(${column}, $2) WHERE id = $1`,
    [row.message_id, bytes.toString('base64')]
  );
}

async function clearUploadedBytes(messageId: number): Promise<void> {
  await pool.query(
    `UPDATE messages SET audio_base64 = NULL, video_base64 = NULL, media_base64 = NULL
     WHERE id = $1 AND NOT EXISTS (
       SELECT 1 FROM demand_media dm WHERE dm.message_id = $1 AND dm.status NOT IN ('synced', 'expired')
     )`,
    [messageId]
  );
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 800);
}

export async function syncDemandMediaToLinear(demandId: number, issueId: string): Promise<void> {
  const result = await pool.query<DemandMediaRow>(
    `SELECT dm.demand_id, dm.message_id, dm.linear_asset_url, m.kind, m.media,
       m.audio_base64, m.video_base64, m.media_base64, m.sent_at, m.sender_jid, m.sender_name,
       m.from_me, c.provider, c.instance
     FROM demand_media dm
     JOIN messages m ON m.id = dm.message_id
     JOIN conversations c ON c.id = m.conversation_id
     WHERE dm.demand_id = $1
       AND (dm.status IN ('pending', 'failed') OR
         (dm.status = 'processing' AND dm.updated_at < now() - interval '15 minutes'))
     ORDER BY dm.created_at, dm.message_id`,
    [demandId]
  );

  let failures = 0;
  for (const row of result.rows) {
    const claimed = await pool.query(
      `UPDATE demand_media SET status = 'processing', attempts = attempts + 1,
         last_error = NULL, updated_at = now()
       WHERE demand_id = $1 AND message_id = $2
         AND (status IN ('pending', 'failed') OR
           (status = 'processing' AND updated_at < now() - interval '15 minutes'))
       RETURNING message_id`,
      [row.demand_id, row.message_id]
    );
    if (!claimed.rowCount) continue;
    try {
      const contentType = contentTypeFor(row);
      const filename = filenameFor(row, contentType);
      let assetUrl = row.linear_asset_url;
      if (!assetUrl) {
        const label = row.kind === 'audio' ? 'áudio' : row.kind === 'video' ? 'vídeo' : 'mídia';
        const bytes = storedBytes(row) ?? await downloadWhatsappMedia(
          row.provider, row.media, limitFor(row.kind), label
        );
        await persistBytes(row, bytes);
        assetUrl = await uploadLinearFile(bytes, filename, contentType);
        await pool.query(
          `UPDATE demand_media SET linear_asset_url = $3, updated_at = now()
           WHERE demand_id = $1 AND message_id = $2`,
          [row.demand_id, row.message_id, assetUrl]
        );
      }

      const sender = row.from_me ? 'Operador' : row.sender_name || row.sender_jid || 'Contato';
      const attachmentId = await createLinearIssueAttachment({
        issueId,
        assetUrl,
        title: `WhatsApp · ${row.kind} · ${filename}`,
        subtitle: `${sender} · ${row.sent_at.toISOString()}`,
        metadata: {
          source: 'whatsapp-ai-project-observer',
          demandId: row.demand_id,
          messageId: row.message_id,
          provider: row.provider,
          instance: row.instance,
          sentAt: row.sent_at.toISOString(),
          sender,
          fromMe: row.from_me ? 'true' : 'false'
        }
      });
      await pool.query(
        `UPDATE demand_media SET status = 'synced', linear_attachment_id = $3,
           last_error = NULL, updated_at = now()
         WHERE demand_id = $1 AND message_id = $2`,
        [row.demand_id, row.message_id, attachmentId]
      );
      await clearUploadedBytes(row.message_id);
    } catch (error) {
      failures += 1;
      await pool.query(
        `UPDATE demand_media SET status = 'failed', last_error = $3, updated_at = now()
         WHERE demand_id = $1 AND message_id = $2`,
        [row.demand_id, row.message_id, safeError(error)]
      );
    }
  }
  if (failures) throw new Error(`${failures} mídia(s) não puderam ser anexadas ao card no Linear`);
}
