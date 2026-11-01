import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { nextProcessAfter, shouldStartNewBatch } from '../batching.js';
import { inTransaction, pool } from '../db/index.js';
import type { NormalizedMessage, Provider } from './whatsapp.js';

export interface IngestSummary {
  stored: number;
  duplicates: number;
  ignored: number;
}

type InsertOutcome = 'stored' | 'duplicate' | 'ignored';

async function insertMessage(client: PoolClient, message: NormalizedMessage): Promise<InsertOutcome> {
  const conversation = await client.query<{ id: number; monitored: boolean }>(
    `SELECT id, monitored FROM conversations
     WHERE provider = $1 AND instance = $2 AND remote_jid = $3 FOR UPDATE`,
    [message.provider, message.instance, message.remoteJid]
  );
  const row = conversation.rows[0];
  if (!row?.monitored) return 'ignored';

  const rawAudio = message.audioBase64?.replace(/^data:[^,]+,/, '') ?? '';
  const audioTooLarge = rawAudio.length > config.maxAudioBytes * 1.4;
  const audioBase64 = !audioTooLarge && /^[A-Za-z0-9+/=\r\n]+$/.test(rawAudio) ? rawAudio : null;
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO messages (
       conversation_id, external_message_id, sent_at, sender_jid, sender_name,
       from_me, kind, text, media, audio_base64, transcript_status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10,
       CASE WHEN $7 = 'audio' THEN 'pending' ELSE 'not_required' END)
     ON CONFLICT (conversation_id, external_message_id) DO NOTHING
     RETURNING id`,
    [
      row.id,
      message.externalMessageId,
      message.sentAt,
      message.senderJid,
      message.senderName,
      message.fromMe,
      message.kind,
      message.text,
      JSON.stringify({ ...message.media, audioPending: message.kind === 'audio' && !audioBase64 }),
      audioBase64
    ]
  );
  const messageRow = inserted.rows[0];
  if (!messageRow) return 'duplicate';

  const receivedAt = new Date();
  const pending = await client.query<{
    id: number;
    first_received_at: Date;
    last_received_at: Date;
    message_count: string;
  }>(
    `SELECT b.id, b.first_received_at, b.last_received_at,
       (SELECT count(*) FROM batch_messages bm WHERE bm.batch_id = b.id)::text AS message_count
     FROM batches b
     WHERE b.conversation_id = $1 AND b.status = 'pending'
     ORDER BY b.id DESC
     LIMIT 1 FOR UPDATE OF b`,
    [row.id]
  );
  const current = pending.rows[0];
  let batchId: number;
  if (!current || shouldStartNewBatch(Number(current.message_count), config.batchMaxMessages)) {
    const processAfter = nextProcessAfter(
      { firstReceivedAt: receivedAt, lastReceivedAt: receivedAt },
      config.batchIdleMs,
      config.batchMaxWaitMs
    );
    const created = await client.query<{ id: number }>(
      `INSERT INTO batches(conversation_id, first_received_at, last_received_at, process_after)
       VALUES ($1, $2, $2, $3) RETURNING id`,
      [row.id, receivedAt, processAfter]
    );
    batchId = created.rows[0]!.id;
  } else {
    const processAfter = nextProcessAfter(
      { firstReceivedAt: current.first_received_at, lastReceivedAt: receivedAt },
      config.batchIdleMs,
      config.batchMaxWaitMs
    );
    batchId = current.id;
    await client.query(
      `UPDATE batches SET last_received_at = $2, process_after = $3
       WHERE id = $1`,
      [batchId, receivedAt, processAfter]
    );
  }
  await client.query('INSERT INTO batch_messages(batch_id, message_id) VALUES ($1, $2)', [batchId, messageRow.id]);
  await client.query(
    'UPDATE conversations SET last_webhook_at = now(), updated_at = now() WHERE id = $1',
    [row.id]
  );
  return 'stored';
}

export async function ingestMessages(messages: NormalizedMessage[]): Promise<IngestSummary> {
  return inTransaction(async (client) => {
    const summary: IngestSummary = { stored: 0, duplicates: 0, ignored: 0 };
    for (const message of messages) {
      const outcome = await insertMessage(client, message);
      if (outcome === 'stored') summary.stored += 1;
      if (outcome === 'duplicate') summary.duplicates += 1;
      if (outcome === 'ignored') summary.ignored += 1;
    }
    return summary;
  });
}

export async function noteWebhook(provider: Provider): Promise<void> {
  await pool.query(
    `INSERT INTO app_state(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [`last_webhook:${provider}`, JSON.stringify({ receivedAt: new Date().toISOString() })]
  );
}

export async function conversationExistsForProject(
  projectId: number,
  provider: Provider,
  instance: string,
  remoteJid: string
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM project_conversations pc
     JOIN conversations c ON c.id = pc.conversation_id
     WHERE pc.project_id = $1 AND c.provider = $2 AND c.instance = $3 AND c.remote_jid = $4`,
    [projectId, provider, instance, remoteJid]
  );
  return Boolean(result.rowCount);
}
