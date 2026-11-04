import { config as loadDotenv } from 'dotenv';
import path from 'node:path';

// In production, .env is the source of truth for saved settings. PM2 can retain
// an old copy of its environment when the process is restarted by name.
loadDotenv({
  path: path.resolve(process.cwd(), '.env'),
  override: process.env.NODE_ENV === 'production'
});

function numberFromEnv(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} precisa ser um número inteiro >= ${minimum}`);
  }
  return parsed;
}

function splitPaths(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '127.0.0.1',
  port: numberFromEnv('PORT', 3105),
  databaseUrl: process.env.DATABASE_URL ?? '',
  adminUser: process.env.ADMIN_USER ?? '',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  evolutionWebhookToken: process.env.EVOLUTION_WEBHOOK_TOKEN ?? '',
  wahaHmacKey: process.env.WAHA_HMAC_KEY ?? '',
  evolutionApiUrl: process.env.EVOLUTION_API_URL?.replace(/\/$/, '') ?? '',
  evolutionApiKey: process.env.EVOLUTION_API_KEY ?? '',
  wahaApiUrl: process.env.WAHA_API_URL?.replace(/\/$/, '') ?? '',
  wahaApiKey: process.env.WAHA_API_KEY ?? '',
  wahaSession: process.env.WAHA_SESSION ?? 'observer',
  codexModel: process.env.CODEX_MODEL ?? 'gpt-6-luna',
  codexInterpretationTimeoutMs: numberFromEnv('CODEX_INTERPRETATION_TIMEOUT_MS', 240_000),
  linearApiKey: process.env.LINEAR_API_KEY ?? '',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  linearFileUploadTimeoutMs: numberFromEnv('LINEAR_FILE_UPLOAD_TIMEOUT_MS', 300_000),
  openaiTranscriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL ?? 'gpt-transcribe',
  openaiTranscriptionTimeoutMs: numberFromEnv('OPENAI_TRANSCRIPTION_TIMEOUT_MS', 300_000),
  linearMaxAttempts: numberFromEnv('LINEAR_MAX_ATTEMPTS', 12),
  repositoryRoots: splitPaths(process.env.REPOSITORY_ROOTS),
  codexCli: process.env.CODEX_CLI ?? 'codex',
  codexTimeoutMs: numberFromEnv('CODEX_TIMEOUT_MS', 600_000),
  ffmpegCli: process.env.FFMPEG_CLI ?? 'ffmpeg',
  ffprobeCli: process.env.FFPROBE_CLI ?? 'ffprobe',
  codexMaxAttempts: numberFromEnv('CODEX_MAX_ATTEMPTS', 5),
  batchIdleMs: numberFromEnv('BATCH_IDLE_MS', 90_000),
  batchMaxWaitMs: numberFromEnv('BATCH_MAX_WAIT_MS', 300_000),
  batchMaxMessages: numberFromEnv('BATCH_MAX_MESSAGES', 30),
  batchMaxAttempts: numberFromEnv('BATCH_MAX_ATTEMPTS', 8),
  maxParallelBatches: numberFromEnv('MAX_PARALLEL_BATCHES', 2),
  codexConcurrency: numberFromEnv('CODEX_CONCURRENCY', 1),
  repositorySyncIntervalMs: numberFromEnv('REPOSITORY_SYNC_INTERVAL_MS', 300_000, 60_000),
  workerPollMs: numberFromEnv('WORKER_POLL_MS', 1_000),
  messageRetentionDays: numberFromEnv('MESSAGE_RETENTION_DAYS', 365, 0),
  maxAudioBytes: numberFromEnv('MAX_AUDIO_BYTES', 25_000_000),
  maxVideoBytes: numberFromEnv('MAX_VIDEO_BYTES', 50_000_000),
  maxMediaBytes: numberFromEnv('MAX_MEDIA_BYTES', 25_000_000),
  videoMaxDurationSeconds: numberFromEnv('VIDEO_MAX_DURATION_SECONDS', 180),
  videoMaxFramesPerMessage: numberFromEnv('VIDEO_MAX_FRAMES_PER_MESSAGE', 6),
  videoMaxFramesPerBatch: numberFromEnv('VIDEO_MAX_FRAMES_PER_BATCH', 12),
  videoProcessingTimeoutMs: numberFromEnv('VIDEO_PROCESSING_TIMEOUT_MS', 120_000)
};

export function validateConfig(): void {
  if (!config.databaseUrl) throw new Error('DATABASE_URL é obrigatório');
  if (!config.adminUser || !config.adminPassword) {
    throw new Error('ADMIN_USER e ADMIN_PASSWORD são obrigatórios');
  }
  if (config.batchMaxWaitMs < config.batchIdleMs) {
    throw new Error('BATCH_MAX_WAIT_MS deve ser >= BATCH_IDLE_MS');
  }
  if (config.codexModel !== 'gpt-6-luna') throw new Error('CODEX_MODEL deve ser exatamente gpt-6-luna');
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(config.wahaSession)) {
    throw new Error('WAHA_SESSION deve conter somente letras, números, ponto, sublinhado ou hífen');
  }
}
