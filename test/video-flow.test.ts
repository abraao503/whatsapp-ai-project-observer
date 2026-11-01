import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test('video webhook persists its media and retries interpretation without losing the video or repeating Whisper', {
  skip: !testDatabaseUrl && 'Configure TEST_DATABASE_URL para habilitar o teste PostgreSQL de vídeo.'
}, async () => {
  if (!testDatabaseUrl) return;

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.ADMIN_USER = 'test-admin';
  process.env.ADMIN_PASSWORD = 'test-password';
  process.env.EVOLUTION_WEBHOOK_TOKEN = 'test-webhook-token';
  process.env.CODEX_MODEL = 'gpt-6-luna';
  process.env.BATCH_IDLE_MS = '5000';
  process.env.BATCH_MAX_WAIT_MS = '10000';
  process.env.VIDEO_MAX_FRAMES_PER_MESSAGE = '2';
  process.env.VIDEO_MAX_FRAMES_PER_BATCH = '2';
  process.env.WORKER_POLL_MS = '10';
  process.env.MAX_PARALLEL_BATCHES = '1';
  process.env.CODEX_CONCURRENCY = '1';

  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'observer-video-flow-'));
  const ffmpeg = path.join(fixtureDirectory, 'ffmpeg');
  const ffprobe = path.join(fixtureDirectory, 'ffprobe');
  const whisper = path.join(fixtureDirectory, 'whisper-cli');
  const codex = path.join(fixtureDirectory, 'codex');
  const model = path.join(fixtureDirectory, 'whisper-model.bin');
  const codexLog = path.join(fixtureDirectory, 'codex.jsonl');
  const ffmpegLog = path.join(fixtureDirectory, 'ffmpeg.jsonl');
  const whisperLog = path.join(fixtureDirectory, 'whisper.jsonl');
  const failMarker = path.join(fixtureDirectory, 'failed-once');
  const ffmpegFailMarker = path.join(fixtureDirectory, 'ffmpeg-failed-once');
  await writeFile(model, 'fixture model');
  await writeFile(ffprobe, `#!/usr/bin/env node
console.log(JSON.stringify({ format: { duration: '2' }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }));
`);
  await writeFile(ffmpeg, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ffmpegLog)}, JSON.stringify(args) + '\\n');
if (args.includes('-map') && !fs.existsSync(${JSON.stringify(ffmpegFailMarker)})) {
  fs.writeFileSync(${JSON.stringify(ffmpegFailMarker)}, 'failed once');
  console.error('temporary ffmpeg failure');
  process.exit(1);
}
fs.writeFileSync(args.at(-1), args.at(-1).endsWith('.jpg') ? 'fixture frame' : 'fixture wav');
`);
  await writeFile(whisper, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(whisperLog)}, JSON.stringify(args) + '\\n');
fs.writeFileSync(args[args.indexOf('--output-file') + 1] + '.txt', 'Clique no botão para exportar.');
`);
  await writeFile(codex, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in'); process.exit(0); }
if (args[0] !== 'exec') process.exit(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const match = prompt.match(/<contexto_json>\\s*([\\s\\S]*?)\\s*<\\/contexto_json>/);
  const context = match ? JSON.parse(match[1]) : null;
  const images = args.flatMap((value, index) => value === '--image' ? [args[index + 1]] : []);
  fs.appendFileSync(${JSON.stringify(codexLog)}, JSON.stringify({ context, images, imageExists: images.map((image) => fs.existsSync(image)) }) + '\\n');
  if (images.some((image) => !fs.existsSync(image))) process.exit(3);
  if (!fs.existsSync(${JSON.stringify(failMarker)})) {
    fs.writeFileSync(${JSON.stringify(failMarker)}, 'failed once');
    console.error('temporary Codex failure');
    process.exit(1);
  }
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ conversationSummary: 'O vídeo demonstra o fluxo de exportação.', actions: [] }));
  console.log('model: ' + args[args.indexOf('--model') + 1]);
});
`);
  for (const executable of [ffmpeg, ffprobe, whisper, codex]) await chmod(executable, 0o700);

  const envNames = ['FFMPEG_CLI', 'FFPROBE_CLI', 'WHISPER_CPP_CLI', 'WHISPER_MODEL_PATH', 'CODEX_CLI', 'CODEX_HOME', 'WHISPER_LANGUAGE', 'WHISPER_THREADS'];
  const original = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    FFMPEG_CLI: ffmpeg,
    FFPROBE_CLI: ffprobe,
    WHISPER_CPP_CLI: whisper,
    WHISPER_MODEL_PATH: model,
    WHISPER_LANGUAGE: 'pt',
    WHISPER_THREADS: '1',
    CODEX_CLI: codex,
    CODEX_HOME: fixtureDirectory
  });

  const originalFetch = globalThis.fetch;
  let db: typeof import('../src/db/index.js') | undefined;
  let app: import('fastify').FastifyInstance | undefined;
  let worker: { stop: () => void } | undefined;
  let projectId: number | undefined;
  let conversationId: number | undefined;
  let errorBaseline: number | undefined;
  let previousWebhookState: unknown;
  let hadWebhookState = false;

  try {
    db = await import('../src/db/index.js');
    await db.initializeDatabase();
    const errors = await db.pool.query<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM app_errors');
    errorBaseline = errors.rows[0]!.id;
    const state = await db.pool.query<{ value: unknown }>("SELECT value FROM app_state WHERE key = 'last_webhook:evolution'");
    hadWebhookState = state.rowCount !== 0;
    previousWebhookState = state.rows[0]?.value;
    const project = await db.pool.query<{ id: number }>(
      `INSERT INTO projects(name, repository_path, reference_branch)
       VALUES ($1, '/tmp', 'main') RETURNING id`,
      [`Vídeo de teste ${Date.now()}`]
    );
    projectId = project.rows[0]!.id;
    const conversation = await db.pool.query<{ id: number; remote_jid: string }>(
      `INSERT INTO conversations(provider, instance, remote_jid, display_name)
       VALUES ('evolution', 'video-test', $1, 'Contato de vídeo') RETURNING id, remote_jid`,
      [`video-${Date.now()}@s.whatsapp.net`]
    );
    conversationId = conversation.rows[0]!.id;
    await db.pool.query('INSERT INTO project_conversations(project_id, conversation_id) VALUES ($1, $2)', [projectId, conversationId]);

    const { validateCodexAccess } = await import('../src/modules/interpreter.js');
    assert.equal((await validateCodexAccess()).state, 'available');
    const { createApp } = await import('../src/server.js');
    app = createApp();
    await app.ready();
    const webhook = await app.inject({
      method: 'POST',
      url: '/webhooks/evolution/test-webhook-token',
      payload: {
        event: 'messages.upsert',
        instance: 'video-test',
        data: {
          key: { remoteJid: conversation.rows[0]!.remote_jid, id: 'video-message-1', fromMe: false },
          pushName: 'Contato de vídeo',
          messageTimestamp: new Date().toISOString(),
          message: { videoMessage: { mimetype: 'video/mp4', caption: 'Veja como o relatório é exportado', base64: Buffer.from('video fixture').toString('base64') } }
        }
      }
    });
    assert.equal(webhook.statusCode, 202, webhook.body);

    const message = await db.pool.query<{ id: number; kind: string; video_base64: string | null; transcript_status: string }>(
      `SELECT id, kind, video_base64, transcript_status FROM messages
       WHERE conversation_id = $1 AND external_message_id = 'video-message-1'`,
      [conversationId]
    );
    assert.equal(message.rows[0]?.kind, 'video');
    assert.equal(message.rows[0]?.video_base64, Buffer.from('video fixture').toString('base64'));
    assert.equal(message.rows[0]?.transcript_status, 'pending');
    const batch = await db.pool.query<{ id: number }>(
      'SELECT id FROM batches WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1', [conversationId]
    );
    const { processBatchInterpretation } = await import('../src/modules/demands.js');
    await assert.rejects(processBatchInterpretation(batch.rows[0]!.id), /temporary ffmpeg failure/);
    const transcriptionFailed = await db.pool.query<{ video_base64: string | null; transcript_status: string }>(
      'SELECT video_base64, transcript_status FROM messages WHERE id = $1', [message.rows[0]!.id]
    );
    assert.equal(transcriptionFailed.rows[0]?.video_base64, Buffer.from('video fixture').toString('base64'));
    assert.equal(transcriptionFailed.rows[0]?.transcript_status, 'failed');

    await assert.rejects(processBatchInterpretation(batch.rows[0]!.id), /temporary Codex failure/);

    const failed = await db.pool.query<{ video_base64: string | null; transcript: string | null; transcript_status: string }>(
      'SELECT video_base64, transcript, transcript_status FROM messages WHERE id = $1', [message.rows[0]!.id]
    );
    assert.equal(failed.rows[0]?.video_base64, Buffer.from('video fixture').toString('base64'));
    assert.equal(failed.rows[0]?.transcript, 'Clique no botão para exportar.');
    assert.equal(failed.rows[0]?.transcript_status, 'done');

    await processBatchInterpretation(batch.rows[0]!.id);
    const calls = (await readFile(codexLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      context: { batchMessages: Array<{ id: string; kind: string; text: string }>; videoFrames: Array<{ messageId: string; timestampSeconds: number }> };
      images: string[];
      imageExists: boolean[];
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.images.length), [2, 2]);
    assert.ok(calls.flatMap((call) => call.imageExists).every(Boolean));
    assert.equal(calls[1]?.context.batchMessages[0]?.kind, 'video');
    assert.match(calls[1]?.context.batchMessages[0]?.text ?? '', /Fala identificada no vídeo/);
    assert.deepEqual(calls[1]?.context.videoFrames.map((frame) => frame.timestampSeconds), [0.5, 1.5]);
    assert.equal((await readFile(whisperLog, 'utf8')).trim().split('\n').length, 1, 'retry reutiliza a transcrição persistida');
    assert.equal((await readFile(ffmpegLog, 'utf8')).trim().split('\n').length, 6, 'o retry do Codex extrai quadros novos sem reextrair o áudio');

    await db.pool.query('UPDATE batches SET process_after = now() WHERE id = $1', [batch.rows[0]!.id]);
    const { startWorker } = await import('../src/jobs/worker.js');
    worker = startWorker();
    const deadline = Date.now() + 10_000;
    let batchStatus = 'pending';
    while (batchStatus !== 'done' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const current = await db.pool.query<{ status: string }>('SELECT status FROM batches WHERE id = $1', [batch.rows[0]!.id]);
      batchStatus = current.rows[0]?.status ?? 'missing';
    }
    assert.equal(batchStatus, 'done', 'o worker conclui o lote após o retry');
    const completedMessage = await db.pool.query<{ video_base64: string | null }>(
      'SELECT video_base64 FROM messages WHERE id = $1', [message.rows[0]!.id]
    );
    assert.equal(completedMessage.rows[0]?.video_base64, null, 'o worker libera o arquivo bruto após concluir o lote');
  } finally {
    globalThis.fetch = originalFetch;
    if (worker) worker.stop();
    if (app) await app.close();
    if (db) {
      if (projectId) await db.pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
      if (conversationId) await db.pool.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      if (errorBaseline !== undefined) await db.pool.query('DELETE FROM app_errors WHERE id > $1', [errorBaseline]);
      if (hadWebhookState) {
        await db.pool.query('UPDATE app_state SET value = $1::jsonb, updated_at = now() WHERE key = $2', [JSON.stringify(previousWebhookState), 'last_webhook:evolution']);
      } else {
        await db.pool.query("DELETE FROM app_state WHERE key = 'last_webhook:evolution'");
      }
      await db.pool.end();
    }
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
