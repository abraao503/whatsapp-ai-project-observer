import { config } from '../config.js';
import { inTransaction, pool, recordError, safeErrorMessage } from '../db/index.js';
import { retryDelayMs } from '../batching.js';
import { processBatchInterpretation } from '../modules/demands.js';
import { analyzeRepository, updateRepositoryContext, type CodexTask } from '../modules/codex.js';
import { createOrUpdateIssue, type LinearDemand, type LinearProject } from '../modules/linear.js';
import { syncDemandMediaToLinear } from '../modules/media-evidence.js';
import { interpreterStatus, validateCodexAccess } from '../modules/interpreter.js';

interface ClaimedBatch {
  id: number;
  conversation_id: number;
  attempts: number;
}

interface ClaimedLinearDemand extends LinearDemand {
  projectId: number;
  version: number;
  linearSyncRevision: number;
  linearIssueIdentifier: string | null;
  linearIssueUrl: string | null;
  project: LinearProject;
}

interface ClaimedCodexJob {
  id: number;
  demand_id: number;
  demand_version: number;
  attempts: number;
  project_id: number;
  project_name: string;
  repository_path: string;
  reference_branch: string;
  analysis_instructions: string;
  title: string;
  summary: string;
  demand_type: string;
  requirements: string[];
  open_questions: string[];
  conversation_context: string;
}

async function claimBatch(): Promise<ClaimedBatch | null> {
  return inTransaction(async (client) => {
    const candidate = await client.query<{ id: number; conversation_id: number }>(
      `SELECT b.id, b.conversation_id
       FROM batches b JOIN conversations c ON c.id = b.conversation_id
       WHERE b.status = 'pending' AND b.process_after <= now()
         AND c.processing_batch_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM batches earlier
           WHERE earlier.conversation_id = b.conversation_id
             AND earlier.id < b.id AND earlier.status IN ('pending', 'processing', 'failed')
         )
       ORDER BY b.process_after, b.id
       LIMIT 1 FOR UPDATE OF c SKIP LOCKED`
    );
    const row = candidate.rows[0];
    if (!row) return null;
    const updated = await client.query<{ id: number; conversation_id: number; attempts: number }>(
      `UPDATE batches SET status = 'processing', attempts = attempts + 1,
         processing_started_at = now(), last_error = NULL
       WHERE id = $1 RETURNING id, conversation_id, attempts`,
      [row.id]
    );
    await client.query('UPDATE conversations SET processing_batch_id = $2 WHERE id = $1', [row.conversation_id, row.id]);
    return updated.rows[0] ?? null;
  });
}

async function finishBatch(batch: ClaimedBatch): Promise<void> {
  await inTransaction(async (client) => {
    await client.query(
      `UPDATE batches SET status = 'done', completed_at = now(), processing_started_at = NULL,
         last_error = NULL WHERE id = $1`,
      [batch.id]
    );
    await client.query(
      'UPDATE conversations SET processing_batch_id = NULL WHERE id = $1 AND processing_batch_id = $2',
      [batch.conversation_id, batch.id]
    );
    await client.query(
      `UPDATE messages m SET audio_base64 = NULL, video_base64 = NULL, media_base64 = NULL
       WHERE m.id IN (SELECT message_id FROM batch_messages WHERE batch_id = $1)
         AND NOT EXISTS (
           SELECT 1 FROM demand_media dm
           WHERE dm.message_id = m.id AND dm.status NOT IN ('synced', 'expired')
         )`,
      [batch.id]
    );
  });
}

async function failBatch(batch: ClaimedBatch, error: unknown): Promise<void> {
  const message = safeErrorMessage(error);
  const failed = batch.attempts >= config.batchMaxAttempts;
  await inTransaction(async (client) => {
    await client.query(
      `UPDATE batches SET status = $2, process_after = now() + ($3::bigint * interval '1 millisecond'),
         processing_started_at = NULL, last_error = $4
       WHERE id = $1`,
      [batch.id, failed ? 'failed' : 'pending', retryDelayMs(batch.attempts), message]
    );
    await client.query(
      'UPDATE conversations SET processing_batch_id = NULL WHERE id = $1 AND processing_batch_id = $2',
      [batch.conversation_id, batch.id]
    );
  });
  await recordError('batch', error, { batchId: batch.id, attempt: batch.attempts, final: failed });
}

async function claimLinearDemand(): Promise<ClaimedLinearDemand | null> {
  if (!config.linearApiKey) return null;
  return inTransaction(async (client) => {
    const candidate = await client.query<{
      id: number;
      project_id: number;
    }>(
      `SELECT d.id, d.project_id
       FROM demands d JOIN projects p ON p.id = d.project_id
       WHERE (d.linear_sync_status = 'pending' OR
          (d.linear_sync_status = 'syncing' AND d.linear_sync_started_at < now() - interval '15 minutes'))
         AND d.linear_next_attempt_at <= now()
         AND p.linear_team_id <> ''
       ORDER BY d.updated_at, d.id
       LIMIT 1 FOR UPDATE OF d SKIP LOCKED`
    );
    const row = candidate.rows[0];
    if (!row) return null;
    const claimed = await client.query<{
      id: number;
      project_id: number;
      title: string;
      summary: string;
      demand_type: string;
      status: string;
      requirements: string[];
      open_questions: string[];
      conversation_context: string;
      technical_analysis: string;
      version: number;
      linear_issue_id: string | null;
      linear_issue_identifier: string | null;
      linear_issue_url: string | null;
      linear_sync_revision: number;
      project_name: string;
      linear_team_id: string;
      linear_project_id: string;
    }>(
      `UPDATE demands d SET linear_sync_status = 'syncing', linear_sync_attempts = linear_sync_attempts + 1,
         linear_sync_started_at = now()
       FROM projects p WHERE d.id = $1 AND p.id = d.project_id
       RETURNING d.id, d.project_id, d.title, d.summary, d.demand_type, d.status,
         d.requirements, d.open_questions, d.conversation_context,
         d.technical_analysis, d.version, d.linear_issue_id, d.linear_issue_identifier,
         d.linear_issue_url, d.linear_sync_revision, p.name AS project_name,
         p.linear_team_id, p.linear_project_id`,
      [row.id]
    );
    const item = claimed.rows[0];
    if (!item) return null;
    return {
      id: item.id,
      projectId: item.project_id,
      version: item.version,
      title: item.title,
      summary: item.summary,
      demandType: item.demand_type,
      status: item.status,
      requirements: item.requirements,
      openQuestions: item.open_questions,
      conversationContext: item.conversation_context,
      technicalAnalysis: item.technical_analysis,
      linearIssueId: item.linear_issue_id,
      linearIssueIdentifier: item.linear_issue_identifier,
      linearIssueUrl: item.linear_issue_url,
      linearSyncRevision: item.linear_sync_revision,
      project: {
        name: item.project_name,
        linearTeamId: item.linear_team_id,
        linearProjectId: item.linear_project_id
      }
    } as ClaimedLinearDemand;
  });
}

async function processLinearDemand(item: ClaimedLinearDemand): Promise<void> {
  try {
    const issue = await createOrUpdateIssue(item, item.project);
    await inTransaction(async (client) => {
      const current = await client.query<{ version: number; status: string }>(
        'SELECT version, status FROM demands WHERE id = $1 FOR UPDATE', [item.id]
      );
      const currentDemand = current.rows[0];
      await client.query(
        `UPDATE demands SET linear_issue_id = COALESCE(linear_issue_id, $2),
           linear_issue_identifier = $3, linear_issue_url = $4, updated_at = now()
         WHERE id = $1`,
        [item.id, issue.id, issue.identifier, issue.url]
      );
      if (currentDemand?.version === item.version && currentDemand.status === 'ready') {
        await client.query(
          `UPDATE codex_jobs SET status = 'superseded', completed_at = now()
           WHERE demand_id = $1 AND status = 'pending' AND demand_version < $2`,
          [item.id, item.version]
        );
        await client.query(
          `INSERT INTO codex_jobs(demand_id, demand_version, status)
           VALUES ($1, $2, 'pending') ON CONFLICT (demand_id, demand_version) DO NOTHING`,
          [item.id, item.version]
        );
      }
    });
    await syncDemandMediaToLinear(item.id, issue.id);
    await pool.query(
      `UPDATE demands SET linear_synced_revision = GREATEST(linear_synced_revision, $2),
         linear_sync_status = CASE WHEN linear_sync_revision > $2 THEN 'pending' ELSE 'synced' END,
         linear_next_attempt_at = now(), linear_sync_started_at = NULL,
         linear_error = NULL, updated_at = now()
       WHERE id = $1`,
      [item.id, item.linearSyncRevision]
    );
  } catch (error) {
    const current = await pool.query<{ linear_sync_attempts: number }>(
      'SELECT linear_sync_attempts FROM demands WHERE id = $1', [item.id]
    );
    const attempt = current.rows[0]?.linear_sync_attempts ?? 1;
    const terminal = attempt >= config.linearMaxAttempts;
    await pool.query(
      `UPDATE demands SET linear_sync_status = $2,
         linear_sync_started_at = NULL, linear_error = $3,
         linear_next_attempt_at = now() + ($4::bigint * interval '1 millisecond'),
         updated_at = now() WHERE id = $1`,
      [item.id, terminal ? 'error' : 'pending', safeErrorMessage(error), retryDelayMs(attempt)]
    );
    await recordError('linear', error, { demandId: item.id, attempt, final: terminal, hadIssue: Boolean(item.linearIssueId) });
  }
}

async function claimCodexJob(): Promise<ClaimedCodexJob | null> {
  return inTransaction(async (client) => {
    await client.query(
      `UPDATE codex_jobs j SET status = 'superseded', completed_at = now()
       FROM demands d WHERE j.demand_id = d.id AND j.status = 'pending'
         AND j.demand_version < d.version`
    );
    const candidate = await client.query<{ id: number }>(
      `SELECT j.id FROM codex_jobs j JOIN demands d ON d.id = j.demand_id
       WHERE j.status = 'pending' AND d.status = 'ready' AND d.linear_issue_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM codex_jobs busy
           WHERE busy.demand_id = j.demand_id AND busy.status = 'processing'
         )
         AND j.next_attempt_at <= now()
       ORDER BY j.created_at, j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`
    );
    const row = candidate.rows[0];
    if (!row) return null;
    const result = await client.query<ClaimedCodexJob>(
      `UPDATE codex_jobs j SET status = 'processing', attempts = attempts + 1, started_at = now(), last_error = NULL
       FROM demands d JOIN projects p ON p.id = d.project_id
       WHERE j.id = $1 AND d.id = j.demand_id
       RETURNING j.id, j.demand_id, j.demand_version, j.attempts,
         p.id AS project_id, p.name AS project_name, p.repository_path, p.reference_branch,
         p.analysis_instructions, d.title, d.summary, d.demand_type, d.requirements,
         d.open_questions, d.conversation_context`,
      [row.id]
    );
    return result.rows[0] ?? null;
  });
}

async function processCodexJob(job: ClaimedCodexJob): Promise<void> {
  try {
    const task: CodexTask = {
      demandId: job.demand_id,
      title: job.title,
      summary: job.summary,
      demandType: job.demand_type,
      requirements: job.requirements,
      openQuestions: job.open_questions,
      conversationContext: job.conversation_context,
      projectName: job.project_name,
      repositoryPath: job.repository_path,
      referenceBranch: job.reference_branch,
      analysisInstructions: job.analysis_instructions
    };
    const analysis = await analyzeRepository(task);
    await inTransaction(async (client) => {
      await client.query(
        `UPDATE codex_jobs SET status = 'done', repository_commit = $2, result = $3,
           completed_at = now(), last_error = NULL WHERE id = $1`,
        [job.id, analysis.commit, analysis.text]
      );
      const demand = await client.query<{ version: number; status: string; linear_issue_id: string | null }>(
        'SELECT version, status, linear_issue_id FROM demands WHERE id = $1 FOR UPDATE', [job.demand_id]
      );
      const current = demand.rows[0];
      if (!current) return;
      if (current.version === job.demand_version && current.status === 'ready') {
        await client.query(
          `UPDATE demands SET technical_analysis = $2,
             linear_sync_revision = linear_sync_revision + CASE WHEN linear_issue_id IS NOT NULL THEN 1 ELSE 0 END,
             linear_next_attempt_at = now(),
             linear_sync_status = CASE
               WHEN linear_issue_id IS NULL THEN linear_sync_status
               WHEN linear_sync_status = 'syncing' THEN 'syncing'
               ELSE 'pending' END,
             updated_at = now() WHERE id = $1`,
          [job.demand_id, analysis.text]
        );
      } else if (current.status === 'ready') {
        await client.query(
          `UPDATE codex_jobs SET status = 'superseded', completed_at = now()
           WHERE demand_id = $1 AND status = 'pending' AND demand_version < $2`,
          [job.demand_id, current.version]
        );
        await client.query(
          `INSERT INTO codex_jobs(demand_id, demand_version, status)
           VALUES ($1, $2, 'pending') ON CONFLICT (demand_id, demand_version) DO NOTHING`,
          [job.demand_id, current.version]
        );
      }
    });
  } catch (error) {
    const terminal = job.attempts >= config.codexMaxAttempts;
    await pool.query(
      `UPDATE codex_jobs SET status = $2, last_error = $3,
         next_attempt_at = now() + ($4::bigint * interval '1 millisecond'),
         started_at = NULL, completed_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
       WHERE id = $1`,
      [job.id, terminal ? 'failed' : 'pending', safeErrorMessage(error), retryDelayMs(job.attempts)]
    );
    await recordError('codex', error, { jobId: job.id, demandId: job.demand_id, attempt: job.attempts, final: terminal });
  }
}

async function cleanOldData(): Promise<void> {
  if (!config.messageRetentionDays) return;
  await pool.query(
    `UPDATE demand_media SET status = 'expired', last_error = 'Mídia removida pela política de retenção', updated_at = now()
     WHERE status NOT IN ('synced', 'expired')
       AND created_at < now() - ($1::text || ' days')::interval`,
    [config.messageRetentionDays]
  );
  await pool.query(
    `UPDATE messages m SET text = '', transcript = NULL, audio_base64 = NULL, video_base64 = NULL,
       media_base64 = NULL, media = '{}'::jsonb,
       sender_jid = '', sender_name = '', transcript_error = NULL,
       transcript_status = CASE WHEN kind IN ('audio', 'video') THEN 'expired' ELSE transcript_status END
     WHERE m.received_at < now() - ($1::text || ' days')::interval
       AND EXISTS (SELECT 1 FROM demand_messages dm WHERE dm.message_id = m.id)
       AND NOT EXISTS (
         SELECT 1 FROM batch_messages bm JOIN batches b ON b.id = bm.batch_id
         WHERE bm.message_id = m.id AND b.status IN ('pending', 'processing', 'failed')
       )`,
    [config.messageRetentionDays]
  );
  await pool.query(
    `DELETE FROM messages m WHERE m.received_at < now() - ($1::text || ' days')::interval
       AND NOT EXISTS (SELECT 1 FROM demand_messages dm WHERE dm.message_id = m.id)
       AND NOT EXISTS (
         SELECT 1 FROM batch_messages bm JOIN batches b ON b.id = bm.batch_id
         WHERE bm.message_id = m.id AND b.status IN ('pending', 'processing', 'failed')
       )`,
    [config.messageRetentionDays]
  );
  await pool.query(
    `DELETE FROM batches WHERE status = 'done' AND completed_at < now() - ($1::text || ' days')::interval`,
    [config.messageRetentionDays]
  );
  await pool.query("DELETE FROM app_errors WHERE created_at < now() - interval '90 days'");
}

export function startWorker(): { stop: () => void } {
  let busy = false;
  let stopping = false;
  let activeBatches = 0;
  let activeCodex = 0;
  let activeLinear = false;
  let lastCodexValidation = Date.now();
  let lastCleanup = 0;
  let repositorySyncBusy = false;
  const repositorySyncNotices = new Map<string, string>();

  const syncRepositories = async () => {
    if (repositorySyncBusy || stopping) return;
    repositorySyncBusy = true;
    try {
      const projects = await pool.query<{ repository_path: string; reference_branch: string }>(
        'SELECT DISTINCT repository_path, reference_branch FROM projects WHERE active = true'
      );
      for (const project of projects.rows) {
        try {
          const results = await updateRepositoryContext(project.repository_path, project.reference_branch);
          repositorySyncNotices.delete(project.repository_path);
          for (const result of results) {
            if (result.status === 'updated') {
              repositorySyncNotices.delete(result.path);
              console.info(`[repository-sync] ${result.name}: ${result.previousCommit.slice(0, 8)} -> ${result.currentCommit.slice(0, 8)}`);
            } else if (result.status === 'ahead') {
              const notice = `A branch local está à frente de origin/${project.reference_branch}`;
              if (repositorySyncNotices.get(result.path) !== notice) {
                repositorySyncNotices.set(result.path, notice);
                console.warn(`[repository-sync] ${result.name}: ${notice}`);
              }
            } else {
              repositorySyncNotices.delete(result.path);
            }
          }
        } catch (error) {
          const notice = safeErrorMessage(error);
          if (repositorySyncNotices.get(project.repository_path) !== notice) {
            repositorySyncNotices.set(project.repository_path, notice);
            await recordError('repository-sync', error, { repositoryPath: project.repository_path });
          }
        }
      }
    } catch (error) {
      const notice = safeErrorMessage(error);
      if (repositorySyncNotices.get('worker') !== notice) {
        repositorySyncNotices.set('worker', notice);
        await recordError('repository-sync', error);
      }
    } finally {
      repositorySyncBusy = false;
    }
  };

  const runBatch = async (batch: ClaimedBatch) => {
    activeBatches += 1;
    try {
      await processBatchInterpretation(batch.id);
      await finishBatch(batch);
    } catch (error) {
      try {
        await failBatch(batch, error);
      } catch (failureError) {
        await recordError('batch-recovery', failureError, { batchId: batch.id });
      }
    } finally {
      activeBatches -= 1;
    }
  };

  const tick = async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      if (interpreterStatus().state !== 'available' && Date.now() - lastCodexValidation > 5 * 60_000) {
        lastCodexValidation = Date.now();
        const status = await validateCodexAccess();
        if (status.state !== 'available') console.warn(`[codex:interpreter] ${status.detail}`);
      }
      while (interpreterStatus().state === 'available' && activeBatches < config.maxParallelBatches) {
        const batch = await claimBatch();
        if (!batch) break;
        void runBatch(batch);
      }
      if (!activeLinear && config.linearApiKey) {
        const item = await claimLinearDemand();
        if (item) {
          activeLinear = true;
          void processLinearDemand(item)
            .catch((error) => recordError('linear-worker', error, { demandId: item.id }))
            .finally(() => { activeLinear = false; });
        }
      }
      while (activeCodex < config.codexConcurrency) {
        const job = await claimCodexJob();
        if (!job) break;
        activeCodex += 1;
        void processCodexJob(job)
          .catch((error) => recordError('codex-worker', error, { jobId: job.id }))
          .finally(() => { activeCodex -= 1; });
      }
      if (Date.now() - lastCleanup > 24 * 60 * 60_000) {
        lastCleanup = Date.now();
        void cleanOldData().catch((error) => recordError('retention', error));
      }
    } catch (error) {
      await recordError('worker', error);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, config.workerPollMs);
  const repositorySyncTimer = setInterval(() => { void syncRepositories(); }, config.repositorySyncIntervalMs);
  void tick();
  void syncRepositories();
  return {
    stop: () => {
      stopping = true;
      clearInterval(timer);
      clearInterval(repositorySyncTimer);
    }
  };
}

export async function retryBatch(batchId: number): Promise<boolean> {
  const result = await pool.query(
    `UPDATE batches SET status = 'pending', process_after = now(), last_error = NULL,
       processing_started_at = NULL
     WHERE id = $1 AND status = 'failed'`,
    [batchId]
  );
  return Boolean(result.rowCount);
}

export async function retryDemand(demandId: number, job: 'linear' | 'codex'): Promise<boolean> {
  if (job === 'linear') {
    const result = await pool.query(
      `UPDATE demands SET linear_sync_status = 'pending', linear_sync_attempts = 0,
         linear_sync_started_at = NULL, linear_error = NULL,
         linear_sync_revision = linear_sync_revision + 1, linear_next_attempt_at = now(), updated_at = now()
       WHERE id = $1 AND linear_issue_id IS NOT NULL`,
      [demandId]
    );
    if (result.rowCount) return true;
    const created = await pool.query(
      `UPDATE demands SET linear_sync_status = 'pending', linear_sync_attempts = 0,
         linear_sync_started_at = NULL, linear_error = NULL,
         linear_sync_revision = GREATEST(linear_sync_revision, 1), linear_next_attempt_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'ready'`,
      [demandId]
    );
    return Boolean(created.rowCount);
  }
  const result = await pool.query<{ version: number }>('SELECT version FROM demands WHERE id = $1 AND status = \'ready\'', [demandId]);
  const version = result.rows[0]?.version;
  if (version === undefined) return false;
  await pool.query(
    `UPDATE codex_jobs SET status = 'superseded', completed_at = now()
     WHERE demand_id = $1 AND status = 'pending'`,
    [demandId]
  );
  await pool.query(
    `INSERT INTO codex_jobs(demand_id, demand_version, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'pending', 0, now())
     ON CONFLICT (demand_id, demand_version) DO UPDATE SET
       status = 'pending', attempts = 0, last_error = NULL, started_at = NULL, completed_at = NULL`,
    [demandId, version]
  );
  return true;
}
