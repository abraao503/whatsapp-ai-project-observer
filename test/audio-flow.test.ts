import assert from 'node:assert/strict';
import test from 'node:test';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test('transcription failure preserves audio and records a retryable message state', {
  skip: !testDatabaseUrl && 'Configure TEST_DATABASE_URL para habilitar o teste PostgreSQL de áudio.'
}, async () => {
  if (!testDatabaseUrl) return;

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.ADMIN_USER = 'test-admin';
  process.env.ADMIN_PASSWORD = 'test-password';
  process.env.EVOLUTION_WEBHOOK_TOKEN = 'test-webhook-token';
  process.env.OPENAI_API_KEY = 'mock-openai-key';
  process.env.OPENAI_MODEL = 'gpt-6-luna';
  process.env.OPENAI_API_TIMEOUT_MS = '5000';

  const originalFetch = globalThis.fetch;
  let db: typeof import('../src/db/index.js') | undefined;
  let app: import('fastify').FastifyInstance | undefined;
  let projectId: number | undefined;
  let conversationId: number | undefined;
  let errorBaseline: number | undefined;
  let previousWebhookState: unknown;
  let hadWebhookState = false;

  globalThis.fetch = async (input) => {
    const url = String(input);
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    return new Response(JSON.stringify({ error: { message: 'falha transitória de teste' } }), { status: 503 });
  };

  try {
    db = await import('../src/db/index.js');
    await db.initializeDatabase();
    const errors = await db.pool.query<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM app_errors');
    errorBaseline = errors.rows[0]!.id;
    const state = await db.pool.query<{ value: unknown }>(
      "SELECT value FROM app_state WHERE key = 'last_webhook:evolution'"
    );
    hadWebhookState = state.rowCount !== 0;
    previousWebhookState = state.rows[0]?.value;

    const project = await db.pool.query<{ id: number }>(
      `INSERT INTO projects(name, repository_path, reference_branch)
       VALUES ($1, '/tmp', 'main') RETURNING id`,
      [`Áudio de teste ${Date.now()}`]
    );
    projectId = project.rows[0]!.id;
    const conversation = await db.pool.query<{ id: number; remote_jid: string }>(
      `INSERT INTO conversations(provider, instance, remote_jid, display_name)
       VALUES ('evolution', 'audio-test', $1, 'Contato de áudio') RETURNING id, remote_jid`,
      [`audio-${Date.now()}@s.whatsapp.net`]
    );
    conversationId = conversation.rows[0]!.id;
    await db.pool.query(
      'INSERT INTO project_conversations(project_id, conversation_id) VALUES ($1, $2)',
      [projectId, conversationId]
    );

    const { createApp } = await import('../src/server.js');
    app = createApp();
    await app.ready();
    const webhook = await app.inject({
      method: 'POST',
      url: '/webhooks/evolution/test-webhook-token',
      payload: {
        event: 'messages.upsert',
        instance: 'audio-test',
        data: {
          key: { remoteJid: conversation.rows[0]!.remote_jid, id: 'audio-message-1', fromMe: false },
          pushName: 'Contato de áudio',
          messageTimestamp: new Date().toISOString(),
          message: { audioMessage: { mimetype: 'audio/ogg', base64: 'T2dnUw==' } }
        }
      }
    });
    assert.equal(webhook.statusCode, 202, webhook.body);

    const pending = await db.pool.query<{
      id: number; kind: string; transcript_status: string; audio_base64: string | null;
    }>(
      `SELECT id, kind, transcript_status, audio_base64 FROM messages
       WHERE conversation_id = $1 AND external_message_id = 'audio-message-1'`,
      [conversationId]
    );
    assert.equal(pending.rows[0]?.kind, 'audio');
    assert.equal(pending.rows[0]?.transcript_status, 'pending');
    assert.equal(pending.rows[0]?.audio_base64, 'T2dnUw==');

    const batch = await db.pool.query<{ id: number }>(
      'SELECT id FROM batches WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1', [conversationId]
    );
    const { processBatchInterpretation } = await import('../src/modules/demands.js');
    await assert.rejects(
      processBatchInterpretation(batch.rows[0]!.id),
      /OpenAI 503: falha transitória de teste/
    );

    const failed = await db.pool.query<{
      transcript_status: string; transcript_error: string | null; audio_base64: string | null;
    }>(
      `SELECT transcript_status, transcript_error, audio_base64 FROM messages WHERE id = $1`,
      [pending.rows[0]!.id]
    );
    assert.equal(failed.rows[0]?.transcript_status, 'failed');
    assert.match(failed.rows[0]?.transcript_error ?? '', /falha transitória de teste/);
    assert.equal(failed.rows[0]?.audio_base64, 'T2dnUw==', 'o áudio fica preservado para uma nova tentativa');
    assert.equal(await db.pool.query('SELECT id FROM demands WHERE project_id = $1', [projectId]).then((result) => result.rowCount), 0);
  } finally {
    if (app) await app.close();
    if (db) {
      if (projectId) await db.pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
      if (conversationId) await db.pool.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      if (errorBaseline !== undefined) await db.pool.query('DELETE FROM app_errors WHERE id > $1', [errorBaseline]);
      if (hadWebhookState) {
        await db.pool.query(
          `UPDATE app_state SET value = $1::jsonb, updated_at = now() WHERE key = 'last_webhook:evolution'`,
          [JSON.stringify(previousWebhookState)]
        );
      } else {
        await db.pool.query("DELETE FROM app_state WHERE key = 'last_webhook:evolution'");
      }
      await db.pool.end();
    }
    globalThis.fetch = originalFetch;
  }
});
