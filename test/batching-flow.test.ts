import assert from 'node:assert/strict';
import test from 'node:test';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test('webhook deduplicates, groups nearby messages, caps the wait, and splits at the message limit', {
  skip: !testDatabaseUrl && 'Configure TEST_DATABASE_URL para habilitar o teste PostgreSQL de agrupamento.'
}, async () => {
  if (!testDatabaseUrl) return;

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.ADMIN_USER = 'test-admin';
  process.env.ADMIN_PASSWORD = 'test-password';
  process.env.EVOLUTION_WEBHOOK_TOKEN = 'test-webhook-token';
  process.env.CODEX_MODEL = 'gpt-6-luna';
  process.env.BATCH_IDLE_MS = '200';
  process.env.BATCH_MAX_WAIT_MS = '350';
  process.env.BATCH_MAX_MESSAGES = '4';

  let db: typeof import('../src/db/index.js') | undefined;
  let app: import('fastify').FastifyInstance | undefined;
  let projectId: number | undefined;
  let conversationId: number | undefined;
  let otherConversationId: number | undefined;
  let errorBaseline: number | undefined;
  let previousWebhookState: unknown;
  let hadWebhookState = false;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    db = await import('../src/db/index.js');
    await db.initializeDatabase();

    const errors = await db.pool.query<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM app_errors');
    errorBaseline = errors.rows[0]!.id;
    const webhookState = await db.pool.query<{ value: unknown }>(
      "SELECT value FROM app_state WHERE key = 'last_webhook:evolution'"
    );
    hadWebhookState = webhookState.rowCount !== 0;
    previousWebhookState = webhookState.rows[0]?.value;

    const projects = await db.pool.query<{ id: number }>(
      `INSERT INTO projects(name, description, repository_path, reference_branch)
       VALUES ($1, 'Projeto temporário para validar debounce', '/tmp', 'main') RETURNING id`,
      [`Agrupamento de teste ${Date.now()}`]
    );
    projectId = projects.rows[0]!.id;
    const conversations = await db.pool.query<{ id: number; remote_jid: string }>(
      `INSERT INTO conversations(provider, instance, remote_jid, display_name)
       VALUES ('evolution', 'batch-test', $1, 'Contato de teste') RETURNING id, remote_jid`,
      [`batch-${Date.now()}@s.whatsapp.net`]
    );
    conversationId = conversations.rows[0]!.id;
    const otherConversation = await db.pool.query<{ id: number; remote_jid: string }>(
      `INSERT INTO conversations(provider, instance, remote_jid, display_name)
       VALUES ('evolution', 'batch-test', $1, 'Outro contato de teste') RETURNING id, remote_jid`,
      [`batch-other-${Date.now()}@s.whatsapp.net`]
    );
    otherConversationId = otherConversation.rows[0]!.id;
    await db.pool.query(
      'INSERT INTO project_conversations(project_id, conversation_id) VALUES ($1, $2)',
      [projectId, conversationId]
    );
    await db.pool.query(
      'INSERT INTO project_conversations(project_id, conversation_id) VALUES ($1, $2)',
      [projectId, otherConversationId]
    );

    const { createApp } = await import('../src/server.js');
    app = createApp();
    await app.ready();

    const sendMessage = async (
      id: string,
      text: string,
      fromMe = false,
      expectedStored = 1,
      remoteJid = conversations.rows[0]!.remote_jid,
      sentAt = new Date().toISOString()
    ) => {
      const response = await app!.inject({
        method: 'POST',
        url: '/webhooks/evolution/test-webhook-token',
        payload: {
          event: 'messages.upsert',
          instance: 'batch-test',
          data: {
            key: { remoteJid, id, fromMe },
            pushName: fromMe ? 'Operador' : 'Contato de teste',
            messageTimestamp: sentAt,
            message: { conversation: text }
          }
        }
      });
      assert.equal(response.statusCode, 202, response.body);
      const result = JSON.parse(response.body) as { stored: number; duplicates: number };
      assert.equal(result.stored, expectedStored);
      return result;
    };

    const readBatch = async (forConversationId = conversationId!) => db!.pool.query<{
      id: number;
      status: string;
      message_count: number;
      first_received_at: Date;
      last_received_at: Date;
      process_after: Date;
    }>(
      `SELECT b.id, b.status, count(bm.message_id)::int AS message_count,
         b.first_received_at, b.last_received_at, b.process_after
       FROM batches b JOIN batch_messages bm ON bm.batch_id = b.id
       WHERE b.conversation_id = $1 GROUP BY b.id ORDER BY b.id`,
      [forConversationId]
    );

    const eventTime = Date.now();
    const at = (offsetMs: number) => new Date(eventTime + offsetMs).toISOString();
    await sendMessage('batch-1', 'Precisamos exportar o relatório mensal.', false, 1, undefined, at(1_000));
    await sendMessage('other-1', 'Outra conversa pede um ajuste independente.', false, 1, otherConversation.rows[0]!.remote_jid);
    const first = (await readBatch()).rows[0]!;
    assert.equal(first.message_count, 1);
    const otherBatch = (await readBatch(otherConversation.rows[0]!.id)).rows[0]!;
    assert.equal(otherBatch.message_count, 1, 'outra conversa tem lote independente');
    assert.notEqual(otherBatch.id, first.id);

    await sleep(90);
    await sendMessage('batch-2', 'A exportação deve ser em Excel.', true, 1, undefined, at(3_000));
    const second = (await readBatch()).rows[0]!;
    assert.equal(second.id, first.id, 'a mensagem seguinte permanece no lote pendente');
    assert.equal(second.message_count, 2);
    assert.ok(second.process_after > first.process_after, 'a atividade reinicia o debounce de inatividade');

    const duplicate = await sendMessage('batch-2', 'A exportação deve ser em Excel.', true, 0);
    assert.equal(duplicate.duplicates, 1, 'webhook repetido é reconhecido pelo ID externo');
    const afterDuplicate = (await readBatch()).rows[0]!;
    assert.equal(
      afterDuplicate.process_after.getTime(), second.process_after.getTime(),
      'uma duplicata não reinicia o debounce nem prolonga o lote'
    );

    await sleep(90);
    await sendMessage('batch-3', 'Inclua filtro por período.', false, 1, undefined, at(4_000));
    const third = (await readBatch()).rows[0]!;
    assert.equal(third.id, first.id);
    assert.equal(third.message_count, 3);
    assert.ok(third.process_after > second.process_after, 'novas mensagens estendem o prazo de silêncio');

    await sleep(90);
    await sendMessage('batch-4', 'Também filtre pelo funcionário.', true, 1, undefined, at(2_000));
    await sendMessage('batch-5', 'Exiba também o total consolidado.');
    const final = await readBatch();
    assert.equal(final.rows.length, 2, 'o limite de mensagens abre um novo lote');
    assert.equal(final.rows[0]?.status, 'pending', 'o webhook persiste sem executar interpretação síncrona');
    assert.equal(final.rows[0]?.message_count, 4);
    assert.equal(final.rows[1]?.status, 'pending');
    assert.equal(final.rows[1]?.message_count, 1);
    assert.notEqual(final.rows[1]?.id, final.rows[0]?.id);

    const orderedMessages = await db.pool.query<{ external_message_id: string }>(
      `SELECT m.external_message_id FROM batch_messages bm JOIN messages m ON m.id = bm.message_id
       WHERE bm.batch_id = $1 ORDER BY m.sent_at, m.id`,
      [final.rows[0]!.id]
    );
    assert.deepEqual(
      orderedMessages.rows.map((row) => row.external_message_id),
      ['batch-1', 'batch-4', 'batch-2', 'batch-3'],
      'mensagens recebidas fora de ordem são lidas pelo horário original do WhatsApp'
    );

    const batch = final.rows[0]!;
    const maximumDeadline = batch.first_received_at.getTime() + 350;
    const idleDeadline = batch.last_received_at.getTime() + 200;
    assert.equal(
      batch.process_after.getTime(),
      Math.min(idleDeadline, maximumDeadline),
      'o prazo fica limitado pelo máximo contado desde a primeira mensagem'
    );
    assert.ok(batch.process_after.getTime() <= maximumDeadline);
  } finally {
    if (app) await app.close();
    if (db) {
      if (projectId) await db.pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
      if (conversationId) await db.pool.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      if (otherConversationId) await db.pool.query('DELETE FROM conversations WHERE id = $1', [otherConversationId]);
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
  }
});
