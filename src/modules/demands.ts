import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { inTransaction, pool } from '../db/index.js';
import type { Interpretation, ObserverContext } from './openai.js';
import { interpret } from './openai.js';
import type { NormalizedMessage } from './whatsapp.js';
import { normalizeDemandTitle } from './whatsapp.js';

interface BatchRow {
  id: number;
  conversation_id: number;
  provider: string;
  instance: string;
  remote_jid: string;
  memory_summary: string;
  decisions: Array<{ projectId: number; text: string; messageIds: string[] }>;
}

interface StoredMessage extends NormalizedMessage {
  id: number;
  transcript: string | null;
  transcriptStatus: string;
}

interface ExistingDemand {
  id: number;
  version: number;
  projectId: number;
  title: string;
  summary: string;
  type: string;
  status: string;
  requirements: string[];
  acceptanceCriteria: string[];
  openQuestions: string[];
  conversationContext: string;
  linearIssueId: string | null;
  linearSyncStatus: string;
  linearSyncRevision: number;
  technicalAnalysis: string;
}

interface ProjectRow {
  id: number;
  name: string;
  description: string;
  repository_path: string;
  reference_branch: string;
  linear_team_id: string;
  linear_project_id: string;
  analysis_instructions: string;
}

const conversationSummaryLimit = 1_600;

async function lockProjects<T>(projectIds: number[], work: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const locked: number[] = [];
  try {
    for (const projectId of [...new Set(projectIds)].sort((a, b) => a - b)) {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`whatsapp-observer-project:${projectId}`]);
      locked.push(projectId);
    }
    return await work();
  } finally {
    try {
      for (const projectId of locked.reverse()) {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`whatsapp-observer-project:${projectId}`]);
      }
    } finally {
      client.release();
    }
  }
}

function mediaFileName(media: Record<string, unknown>): string {
  const fileName = typeof media.fileName === 'string' ? media.fileName : '';
  return /^[a-zA-Z0-9._-]{1,100}$/.test(fileName) ? fileName : 'voice.ogg';
}

function mediaMimeType(media: Record<string, unknown>): string {
  const mimeType = typeof media.mimetype === 'string' ? media.mimetype : '';
  return mimeType.startsWith('audio/') ? mimeType : 'audio/ogg';
}

async function loadAudioBytes(message: StoredMessage): Promise<Buffer> {
  if (message.audioBase64) return Buffer.from(message.audioBase64.replace(/\s/g, ''), 'base64');
  const mediaUrl = typeof message.media.url === 'string' ? message.media.url : '';
  const apiUrl = message.provider === 'waha' ? config.wahaApiUrl : config.evolutionApiUrl;
  const apiKey = message.provider === 'waha' ? config.wahaApiKey : config.evolutionApiKey;
  if (!apiUrl || !mediaUrl) throw new Error('Áudio preservado sem base64; configure webhookBase64 ou a URL de mídia da API');

  let mediaPath: string;
  try {
    mediaPath = new URL(mediaUrl, 'http://local.invalid').pathname + new URL(mediaUrl, 'http://local.invalid').search;
  } catch {
    throw new Error('URL de mídia de áudio inválida');
  }
  if (!mediaPath.startsWith('/api/files/')) throw new Error('A URL de mídia deve apontar para /api/files/');
  const headers: Record<string, string> = {};
  if (apiKey) headers[message.provider === 'waha' ? 'X-Api-Key' : 'apikey'] = apiKey;
  const response = await fetch(`${apiUrl}${mediaPath}`, {
    headers,
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Download do áudio respondeu HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > config.maxAudioBytes) throw new Error('O áudio excede MAX_AUDIO_BYTES');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('O arquivo de áudio recebido está vazio');
  if (bytes.length > config.maxAudioBytes) throw new Error('O áudio excede MAX_AUDIO_BYTES');
  return bytes;
}

async function transcribeBatchAudios(batchId: number): Promise<void> {
  const result = await pool.query<{
    id: number;
    provider: string;
    audio_base64: string | null;
    media: Record<string, unknown>;
    transcript_status: string;
  }>(
    `SELECT m.id, c.provider, m.audio_base64, m.media, m.transcript_status
     FROM batch_messages bm
     JOIN messages m ON m.id = bm.message_id
     JOIN conversations c ON c.id = m.conversation_id
     WHERE bm.batch_id = $1 AND m.kind = 'audio'
       AND m.transcript_status <> 'done'
     ORDER BY m.sent_at, m.id`,
    [batchId]
  );

  for (const row of result.rows) {
    const message: StoredMessage = {
      id: row.id,
      provider: row.provider as StoredMessage['provider'],
      instance: '',
      remoteJid: '',
      externalMessageId: '',
      sentAt: new Date(),
      senderJid: '',
      senderName: '',
      fromMe: false,
      kind: 'audio',
      text: '',
      media: row.media,
      audioBase64: row.audio_base64,
      transcript: null,
      transcriptStatus: row.transcript_status
    };
    try {
      const bytes = await loadAudioBytes(message);
      const { transcribeAudio } = await import('./openai.js');
      const transcript = await transcribeAudio(bytes, mediaMimeType(row.media), mediaFileName(row.media));
      await pool.query(
        `UPDATE messages SET transcript = $2, transcript_status = 'done',
          transcript_error = NULL, audio_base64 = NULL
         WHERE id = $1`,
        [row.id, transcript]
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800);
      await pool.query(
        `UPDATE messages SET transcript_status = 'failed', transcript_error = $2 WHERE id = $1`,
        [row.id, messageText]
      );
      throw error;
    }
  }
}

async function readBatch(batchId: number): Promise<{ batch: BatchRow; messages: StoredMessage[] }> {
  const batchResult = await pool.query<BatchRow>(
    `SELECT b.id, c.id AS conversation_id, c.provider, c.instance, c.remote_jid,
       c.memory_summary, c.decisions
     FROM batches b JOIN conversations c ON c.id = b.conversation_id
     WHERE b.id = $1`,
    [batchId]
  );
  const batch = batchResult.rows[0];
  if (!batch) throw new Error(`Lote ${batchId} não encontrado`);
  const messageResult = await pool.query<{
    id: number;
    external_message_id: string;
    sent_at: Date;
    sender_jid: string;
    sender_name: string;
    from_me: boolean;
    kind: StoredMessage['kind'];
    text: string;
    media: Record<string, unknown>;
    audio_base64: string | null;
    transcript: string | null;
    transcript_status: string;
  }>(
    `SELECT m.id, m.external_message_id, m.sent_at, m.sender_jid, m.sender_name,
       m.from_me, m.kind, m.text, m.media, m.audio_base64, m.transcript, m.transcript_status
     FROM batch_messages bm JOIN messages m ON m.id = bm.message_id
     WHERE bm.batch_id = $1 ORDER BY m.sent_at, m.id`,
    [batchId]
  );
  const messages = messageResult.rows.map((row): StoredMessage => ({
    id: row.id,
    provider: batch.provider as StoredMessage['provider'],
    instance: batch.instance,
    remoteJid: batch.remote_jid,
    externalMessageId: row.external_message_id,
    sentAt: row.sent_at,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    fromMe: row.from_me,
    kind: row.kind,
    text: row.text,
    media: row.media,
    audioBase64: row.audio_base64,
    transcript: row.transcript,
    transcriptStatus: row.transcript_status
  }));
  return { batch, messages };
}

async function buildContext(batch: BatchRow, messages: StoredMessage[]): Promise<{
  context: ObserverContext;
  projects: ProjectRow[];
  demands: ExistingDemand[];
}> {
  const projectResult = await pool.query<ProjectRow>(
    `SELECT p.id, p.name, p.description, p.repository_path, p.reference_branch,
       p.linear_team_id, p.linear_project_id, p.analysis_instructions
     FROM project_conversations pc JOIN projects p ON p.id = pc.project_id
     WHERE pc.conversation_id = $1 AND p.active ORDER BY p.id`,
    [batch.conversation_id]
  );
  const projects = projectResult.rows;
  const demands: ExistingDemand[] = [];
  const aiProjects: ObserverContext['projects'] = [];

  for (const project of projects) {
    const demandResult = await pool.query<{
      id: number;
      version: number;
      title: string;
      summary: string;
      demand_type: string;
      status: string;
      requirements: string[];
      acceptance_criteria: string[];
      open_questions: string[];
      conversation_context: string;
      linear_issue_id: string | null;
      linear_sync_status: string;
      linear_sync_revision: number;
      technical_analysis: string;
    }>(
      `SELECT id, version, title, summary, demand_type, status, requirements,
         acceptance_criteria, open_questions, conversation_context, linear_issue_id,
         linear_sync_status, linear_sync_revision, technical_analysis
       FROM demands WHERE project_id = $1 AND status <> 'cancelled'
       ORDER BY updated_at DESC LIMIT 40`,
      [project.id]
    );
    const projectDemands = demandResult.rows.map((row): ExistingDemand => ({
      id: row.id,
      version: row.version,
      projectId: project.id,
      title: row.title,
      summary: row.summary,
      type: row.demand_type,
      status: row.status,
      requirements: row.requirements,
      acceptanceCriteria: row.acceptance_criteria,
      openQuestions: row.open_questions,
      conversationContext: row.conversation_context,
      linearIssueId: row.linear_issue_id,
      linearSyncStatus: row.linear_sync_status,
      linearSyncRevision: row.linear_sync_revision,
      technicalAnalysis: row.technical_analysis
    }));
    demands.push(...projectDemands);
    aiProjects.push({
      id: project.id,
      name: project.name,
      description: project.description,
      technicalInstructions: project.analysis_instructions,
      demands: projectDemands.map((demand) => ({
        id: demand.id,
        version: demand.version,
        title: demand.title,
        summary: demand.summary,
        type: demand.type,
        status: demand.status,
        requirements: demand.requirements,
        openQuestions: demand.openQuestions
      }))
    });
  }

  const previous = await pool.query<{
    id: number;
    text: string;
    transcript: string | null;
    kind: string;
    sender_name: string;
    sender_jid: string;
    from_me: boolean;
  }>(
    `SELECT m.id, m.text, m.transcript, m.kind, m.sender_name, m.sender_jid, m.from_me
     FROM messages m
     WHERE m.conversation_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM batch_messages bm JOIN batches b ON b.id = bm.batch_id
         WHERE bm.message_id = m.id AND b.id >= $2
       )
     ORDER BY m.sent_at DESC, m.id DESC LIMIT 8`,
    [batch.conversation_id, batch.id]
  );
  const recentMessages = previous.rows.reverse().map((row) => ({
    id: String(row.id),
    sender: row.from_me ? 'Operador' : row.sender_name || row.sender_jid || 'Contato',
    fromMe: row.from_me,
    text: row.transcript || row.text || `[${row.kind}]`
  }));
  const batchMessages = messages.map((message) => ({
    id: String(message.id),
    sentAt: message.sentAt.toISOString(),
    sender: message.fromMe ? 'Operador' : message.senderName || message.senderJid || 'Contato',
    fromMe: message.fromMe,
    text: message.transcript || message.text || `[${message.kind}]`
  }));

  return {
    projects,
    demands,
    context: {
      conversation: {
        provider: batch.provider,
        instance: batch.instance,
        remoteJid: batch.remote_jid,
        summary: batch.memory_summary,
        decisions: Array.isArray(batch.decisions) ? batch.decisions.slice(-20) : []
      },
      recentMessages,
      projects: aiProjects,
      batchMessages
    }
  };
}

function cleanList(values: string[], maxItems: number, maxLength: number): string[] {
  return values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

async function upsertDemand(
  client: PoolClient,
  projectId: number,
  conversationSummary: string,
  action: Interpretation['actions'][number],
  evidenceIds: string[],
  demands: ExistingDemand[]
): Promise<void> {
  const title = action.title.trim().slice(0, 140);
  const summary = action.summary.trim().slice(0, 1_800);
  const requirements = cleanList(action.requirements, 8, 400);
  const acceptanceCriteria = cleanList(action.acceptanceCriteria, 6, 400);
  const openQuestions = cleanList(action.openQuestions, 4, 300);
  const conversationContext = conversationSummary.trim().slice(0, conversationSummaryLimit);
  if (title.length < 6 || summary.length < 5 || action.confidence < 0.55) return;
  if (!requirements.length && action.ready) return;
  if (!requirements.length && summary.length < 30) return;

  let existing: ExistingDemand | undefined;
  if (action.demandId !== null) {
    existing = demands.find((demand) => demand.id === action.demandId && demand.projectId === projectId);
  }
  if (!existing && action.action === 'new') {
    const normalizedTitle = normalizeDemandTitle(title);
    existing = demands.find((demand) => demand.projectId === projectId &&
      demand.status !== 'cancelled' && normalizeDemandTitle(demand.title) === normalizedTitle);
  }

  const messageIds = evidenceIds.map((value) => BigInt(value));
  if (existing) {
    if (action.demandVersion !== null && action.demandVersion !== existing.version) {
      throw new Error(`A demanda ${existing.id} mudou durante a interpretação; o lote será reinterpretado`);
    }
    const nextStatus = action.action === 'cancel' ? 'cancelled' : action.ready ? 'ready' : 'pending_context';
    const nextTitle = title || existing.title;
    const nextSummary = summary || existing.summary;
    const nextType = action.type || existing.type;
    const nextRequirements = requirements.length ? requirements : existing.requirements;
    const nextAcceptanceCriteria = acceptanceCriteria.length ? acceptanceCriteria : existing.acceptanceCriteria;
    const changed = nextTitle !== existing.title || nextSummary !== existing.summary || nextType !== existing.type ||
      JSON.stringify(nextRequirements) !== JSON.stringify(existing.requirements) ||
      JSON.stringify(nextAcceptanceCriteria) !== JSON.stringify(existing.acceptanceCriteria) ||
      JSON.stringify(openQuestions) !== JSON.stringify(existing.openQuestions) ||
      nextStatus !== existing.status || conversationContext !== existing.conversationContext;
    if (changed) {
      const needsLinearSync = Boolean(existing.linearIssueId) || nextStatus === 'ready' || nextStatus === 'cancelled';
      await client.query(
        `UPDATE demands SET title = $2, summary = $3, demand_type = $4, status = $5,
           requirements = $6::jsonb, acceptance_criteria = $7::jsonb, open_questions = $8::jsonb,
           conversation_context = $9, version = version + 1,
           technical_analysis = '',
           linear_sync_revision = linear_sync_revision + CASE WHEN $10 THEN 1 ELSE 0 END,
           linear_next_attempt_at = CASE WHEN $10 THEN now() ELSE linear_next_attempt_at END,
           linear_sync_status = CASE
             WHEN $10 AND linear_sync_status = 'syncing' THEN 'syncing'
             WHEN $10 THEN 'pending'
             WHEN status = 'pending_context' AND NOT $11 THEN 'not_ready'
             ELSE linear_sync_status
           END,
           updated_at = now()
         WHERE id = $1`,
        [
          existing.id, nextTitle, nextSummary, nextType, nextStatus,
          JSON.stringify(nextRequirements), JSON.stringify(nextAcceptanceCriteria),
          JSON.stringify(openQuestions), conversationContext, needsLinearSync,
          Boolean(existing.linearIssueId)
        ]
      );
      existing.version += 1;
      existing.title = nextTitle;
      existing.summary = nextSummary;
      existing.type = nextType;
      existing.status = nextStatus;
      existing.requirements = nextRequirements;
      existing.acceptanceCriteria = nextAcceptanceCriteria;
      existing.openQuestions = openQuestions;
      existing.conversationContext = conversationContext;
      existing.technicalAnalysis = '';
    }
    for (const messageId of messageIds) {
      await client.query(
        'INSERT INTO demand_messages(demand_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [existing.id, messageId.toString()]
      );
    }
    return;
  }

  if (action.action !== 'new' || action.demandId !== null) return;
  const nextStatus = action.ready ? 'ready' : 'pending_context';
  const created = await client.query<{ id: number }>(
    `INSERT INTO demands(
       project_id, title, summary, demand_type, status, requirements, acceptance_criteria,
       open_questions, conversation_context, linear_sync_status, linear_sync_revision
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11)
     RETURNING id`,
    [
      projectId, title, summary, action.type, nextStatus,
      JSON.stringify(requirements), JSON.stringify(acceptanceCriteria), JSON.stringify(openQuestions),
      conversationContext, nextStatus === 'ready' ? 'pending' : 'not_ready',
      nextStatus === 'ready' ? 1 : 0
    ]
  );
  const demandId = created.rows[0]!.id;
  for (const messageId of messageIds) {
    await client.query(
      'INSERT INTO demand_messages(demand_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [demandId, messageId.toString()]
    );
  }
  demands.push({
    id: demandId,
    version: 1,
    projectId,
    title,
    summary,
    type: action.type,
    status: nextStatus,
    requirements,
    acceptanceCriteria,
    openQuestions,
    conversationContext,
    linearIssueId: null,
    linearSyncStatus: nextStatus === 'ready' ? 'pending' : 'not_ready',
    linearSyncRevision: nextStatus === 'ready' ? 1 : 0,
    technicalAnalysis: ''
  });
}

async function applyInterpretation(
  batch: BatchRow,
  messages: StoredMessage[],
  interpretation: Interpretation,
  projects: ProjectRow[],
  demands: ExistingDemand[]
): Promise<void> {
  const allowedProjectIds = new Set(projects.map((project) => project.id));
  const messageIds = new Set(messages.map((message) => message.id));
  const seenDemandIds = new Set<number>();
  const decisions = Array.isArray(batch.decisions) ? batch.decisions.slice(-40) : [];

  await inTransaction(async (client) => {
    for (const action of interpretation.actions) {
      if (action.action === 'ignore') continue;
      const evidence = action.evidenceMessageIds
        .filter((id) => Number.isSafeInteger(Number(id)) && messageIds.has(Number(id)));
      if (!evidence.length) continue;
      const projectId = action.projectId;
      if (projectId === null || !allowedProjectIds.has(projectId)) continue;

      if (action.action === 'decision') {
        const decision = action.decision.trim().slice(0, 1_000);
        if (decision) decisions.push({ projectId, text: decision, messageIds: evidence });
        continue;
      }

      const target = action.demandId === null
        ? undefined
        : demands.find((demand) => demand.id === action.demandId && demand.projectId === projectId);
      if (action.demandId !== null && !target) continue;
      if (target && seenDemandIds.has(target.id)) continue;
      if (target) seenDemandIds.add(target.id);
      await upsertDemand(client, projectId, interpretation.conversationSummary, action, evidence, demands);
    }

    await client.query(
      `UPDATE conversations SET memory_summary = $2, decisions = $3::jsonb, updated_at = now()
       WHERE id = $1`,
      [batch.conversation_id, interpretation.conversationSummary.trim().slice(0, conversationSummaryLimit), JSON.stringify(decisions.slice(-40))]
    );
  });
}

export async function processBatchInterpretation(batchId: number): Promise<void> {
  await transcribeBatchAudios(batchId);
  const { batch, messages } = await readBatch(batchId);
  const linkResult = await pool.query<{ id: number }>(
    `SELECT p.id FROM project_conversations pc JOIN projects p ON p.id = pc.project_id
     WHERE pc.conversation_id = $1 AND p.active ORDER BY p.id`,
    [batch.conversation_id]
  );
  const projectIds = linkResult.rows.map((row) => row.id);
  if (!projectIds.length) return;

  await lockProjects(projectIds, async () => {
    const { context, projects, demands } = await buildContext(batch, messages);
    const interpretation = await interpret(context);
    if (interpretation.conversationSummary.length > conversationSummaryLimit || interpretation.actions.length > 40) {
      throw new Error('A interpretação excedeu os limites da aplicação');
    }
    await applyInterpretation(batch, messages, interpretation, projects, demands);
  });
}
