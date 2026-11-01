import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test('mocked WhatsApp webhook persists a demand, creates a Linear card, then edits that card after a refinement', {
  skip: !testDatabaseUrl && 'Configure TEST_DATABASE_URL para habilitar o teste PostgreSQL de fluxo.'
}, async () => {
  if (!testDatabaseUrl) return;

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.ADMIN_USER = 'test-admin';
  process.env.ADMIN_PASSWORD = 'test-password';
  process.env.EVOLUTION_WEBHOOK_TOKEN = 'test-webhook-token';
  process.env.CODEX_MODEL = 'gpt-6-luna';
  process.env.LINEAR_API_KEY = 'mock-linear-key';
  process.env.REPOSITORY_ROOTS = '/tmp';
  process.env.BATCH_IDLE_MS = '50';
  process.env.BATCH_MAX_WAIT_MS = '120';
  process.env.WORKER_POLL_MS = '25';
  process.env.MAX_PARALLEL_BATCHES = '1';
  process.env.CODEX_CONCURRENCY = '1';
  process.env.CODEX_MAX_ATTEMPTS = '1';
  const originalCodexCli = process.env.CODEX_CLI;
  const originalCodexHome = process.env.CODEX_HOME;
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'observer-flow-codex-'));
  const fakeCodex = path.join(fixtureDirectory, 'codex');
  const releaseFirst = path.join(fixtureDirectory, 'release-first');
  const inputLog = path.join(fixtureDirectory, 'inputs.jsonl');
  await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex test-fixture'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (args[0] !== 'exec' || !args.includes('--output-schema')) {
  console.error('synthetic repository analysis failure'); process.exit(1);
}
if (process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY must not reach Codex'); process.exit(2); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  try {
    const match = prompt.match(/<contexto_json>\\s*([\\s\\S]*?)\\s*<\\/contexto_json>/);
    if (!match) throw new Error('context JSON absent');
    const context = JSON.parse(match[1]);
    const project = context.projects[0];
    const prior = project.demands[0];
    const message = context.batchMessages[0];
    const update = Boolean(prior);
    const result = {
      conversationSummary: update ? 'Cliente pediu exportação em Excel e confirmou filtros por data e funcionário.' : 'Cliente pediu exportação de relatórios em Excel.',
      actions: [{
        action: update ? 'update' : 'new', demandId: prior?.id ?? null, demandVersion: prior?.version ?? null,
        projectId: project.id,
        title: update ? 'Exportar relatórios em Excel com filtros' : 'Exportar relatórios em Excel',
        summary: update ? 'Exportar os relatórios em Excel, com filtros por data e funcionário.' : 'Permitir exportar os relatórios para uma planilha Excel.',
        type: 'feature',
        requirements: update ? ['Exportar relatórios em Excel', 'Filtrar por data', 'Filtrar por funcionário'] : ['Exportar relatórios em Excel'],
        acceptanceCriteria: update ? ['A planilha contém apenas os registros que atendem aos filtros.'] : ['O sistema gera uma planilha Excel com os relatórios.'],
        openQuestions: [], ready: true, confidence: 0.96, decision: '', evidenceMessageIds: [message.id]
      }]
    };
    fs.appendFileSync(${JSON.stringify(inputLog)}, JSON.stringify({ model: args[args.indexOf('--model') + 1], context }) + '\\n');
    const output = args[args.indexOf('--output-last-message') + 1];
    fs.writeFileSync(output, JSON.stringify(result));
    console.log('model: ' + args[args.indexOf('--model') + 1]);
    if (fs.readFileSync(${JSON.stringify(inputLog)}, 'utf8').trim().split('\\n').length === 1) {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(${JSON.stringify(releaseFirst)}) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
});
`, { mode: 0o700 });
  await chmod(fakeCodex, 0o700);
  process.env.CODEX_CLI = fakeCodex;
  process.env.CODEX_HOME = fixtureDirectory;

  const calls: Array<{ service: 'linear'; operation: string; body: Record<string, unknown> }> = [];
  const linearLabels: Array<{ id: string; name: string }> = [];
  let issueLabels: Array<{ id: string; name: string }> = [];
  const originalFetch = globalThis.fetch;
  let worker: { stop: () => void } | undefined;
  let app: import('fastify').FastifyInstance | undefined;
  let projectId: number | undefined;
  let conversationId: number | undefined;
  let recoveryConversationId: number | undefined;
  let errorBaseline: number | undefined;
  let previousWebhookState: unknown;
  let hadWebhookState = false;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url === 'https://api.linear.app/graphql') {
      const query = String(body.query);
      if (query.includes('query ObserverTeamLabels')) {
        return new Response(JSON.stringify({ data: { issueLabels: { nodes: linearLabels } } }), { status: 200 });
      }
      if (query.includes('mutation CreateObserverLabel')) {
        const input = (body.variables as { input: { name: string } }).input;
        const label = { id: `label-${linearLabels.length + 1}`, name: input.name };
        linearLabels.push(label);
        return new Response(JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: label } } }), { status: 200 });
      }
      if (query.includes('query ObserverIssueLabels')) {
        return new Response(JSON.stringify({ data: { issue: { labels: { nodes: issueLabels } } } }), { status: 200 });
      }
      if (query.includes('mutation UpdateObserverIssueLabels')) {
        const input = (body.variables as { input: { labelIds: string[] } }).input;
        issueLabels = linearLabels.filter((label) => input.labelIds.includes(label.id));
        calls.push({ service: 'linear', operation: 'labels-update', body });
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 });
      }
      if (query.includes('query FindObserverIssue')) {
        calls.push({ service: 'linear', operation: 'find', body });
        return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), { status: 200 });
      }
      if (query.includes('mutation CreateObserverIssue')) {
        calls.push({ service: 'linear', operation: 'create', body });
        const input = body.variables as { input: { title: string; labelIds: string[] } };
        issueLabels = linearLabels.filter((label) => input.input.labelIds.includes(label.id));
        return new Response(JSON.stringify({ data: { issueCreate: { success: true, issue: {
          id: 'local-issue-42', identifier: 'OBS-42', url: 'https://linear.local/OBS-42', title: input.input.title
        } } } }), { status: 200 });
      }
      if (query.includes('mutation UpdateObserverIssue')) {
        calls.push({ service: 'linear', operation: 'update', body });
        const variables = body.variables as { id: string; input: { title: string; description: string } };
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true, issue: {
          id: variables.id, identifier: 'OBS-42', url: 'https://linear.local/OBS-42', title: variables.input.title
        } } } }), { status: 200 });
      }
    }
    throw new Error(`Chamada externa inesperada no teste: ${url}`);
  };

  const waitFor = async <T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> => {
    const deadline = Date.now() + 10_000;
    let value = await read();
    while (!ready(value) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      value = await read();
    }
    assert.ok(ready(value), `Timeout aguardando ${label}`);
    return value;
  };

  let db: typeof import('../src/db/index.js') | undefined;
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
    const recoveryConversation = await db.pool.query<{ id: number }>(
      `INSERT INTO conversations(provider, instance, remote_jid, monitored)
       VALUES ('evolution', 'recovery-test', $1, FALSE) RETURNING id`,
      [`recovery-${Date.now()}@s.whatsapp.net`]
    );
    recoveryConversationId = recoveryConversation.rows[0]!.id;
    const interruptedBatch = await db.pool.query<{ id: number }>(
      `INSERT INTO batches(conversation_id, first_received_at, last_received_at, process_after, status)
       VALUES ($1, now(), now(), now(), 'processing') RETURNING id`,
      [recoveryConversationId]
    );
    await db.pool.query('UPDATE conversations SET processing_batch_id = $2 WHERE id = $1', [
      recoveryConversationId, interruptedBatch.rows[0]!.id
    ]);
    await db.initializeDatabase();
    const recovered = await db.pool.query<{ batch_status: string; processing_batch_id: number | null }>(
      `SELECT b.status AS batch_status, c.processing_batch_id FROM batches b
       JOIN conversations c ON c.id = b.conversation_id WHERE b.id = $1`,
      [interruptedBatch.rows[0]!.id]
    );
    assert.equal(recovered.rows[0]?.batch_status, 'pending');
    assert.equal(recovered.rows[0]?.processing_batch_id, null);
    await db.pool.query('DELETE FROM conversations WHERE id = $1', [recoveryConversationId]);
    recoveryConversationId = undefined;

    const projectName = `Fluxo de teste ${Date.now()}`;
    const projects = await db.pool.query<{ id: number }>(
      `INSERT INTO projects(name, description, repository_path, reference_branch, linear_team_id, linear_project_id)
       VALUES ($1, $2, '/tmp/observer-test-repository-does-not-exist', 'main', 'team-local', 'project-local')
       RETURNING id`,
      [projectName, 'Projeto temporário de validação']
    );
    projectId = projects.rows[0]!.id;
    const conversations = await db.pool.query<{ id: number }>(
      `INSERT INTO conversations(provider, instance, remote_jid, display_name)
       VALUES ('evolution', 'local-mock', $1, 'Contato simulado') RETURNING id`,
      [`551199999${Date.now().toString().slice(-4)}@s.whatsapp.net`]
    );
    conversationId = conversations.rows[0]!.id;
    await db.pool.query(
      'INSERT INTO project_conversations(project_id, conversation_id) VALUES ($1,$2)',
      [projectId, conversationId]
    );

    const { validateCodexAccess } = await import('../src/modules/interpreter.js');
    const model = await validateCodexAccess();
    assert.equal(model.state, 'available');
    const { createApp } = await import('../src/server.js');
    app = createApp();
    await app.ready();
    const { startWorker } = await import('../src/jobs/worker.js');
    worker = startWorker();

    const initialEvent = {
      event: 'messages.upsert',
      instance: 'local-mock',
      data: {
        key: { remoteJid: conversations.rows[0]!.id.toString() + '@s.whatsapp.net', id: 'mock-customer-1', fromMe: false },
        pushName: 'Contato simulado',
        messageTimestamp: '2026-10-31T10:00:00.000Z',
        message: { conversation: 'Precisamos exportar os relatórios para Excel.' }
      }
    };
    initialEvent.data.key.remoteJid = (await db.pool.query<{ remote_jid: string }>(
      'SELECT remote_jid FROM conversations WHERE id = $1', [conversationId]
    )).rows[0]!.remote_jid;

    const firstWebhook = await app.inject({
      method: 'POST',
      url: '/webhooks/evolution/test-webhook-token',
      payload: initialEvent
    });
    assert.equal(firstWebhook.statusCode, 202, firstWebhook.body);
    assert.deepEqual(JSON.parse(firstWebhook.body), { received: true, stored: 1, duplicates: 0, ignored: 0 });

    await waitFor(
      async () => readFile(inputLog, 'utf8').catch(() => ''),
      (log) => Boolean(log.trim()),
      'início da primeira interpretação pelo Codex CLI'
    );

    const duplicateWebhook = await app.inject({
      method: 'POST',
      url: '/webhooks/evolution/test-webhook-token',
      payload: initialEvent
    });
    assert.equal(JSON.parse(duplicateWebhook.body).duplicates, 1);

    const refinement = await app.inject({
      method: 'POST',
      url: '/webhooks/evolution/test-webhook-token/send.message',
      payload: {
        instance: 'local-mock',
        data: {
          key: { remoteJid: initialEvent.data.key.remoteJid, id: 'mock-operator-2', fromMe: true },
          messageTimestamp: '2026-10-31T10:02:00.000Z',
          message: { conversation: 'Inclua filtros por data e por funcionário.' }
        }
      }
    });
    assert.equal(refinement.statusCode, 202, refinement.body);
    assert.deepEqual(JSON.parse(refinement.body), { received: true, stored: 1, duplicates: 0, ignored: 0 });
    await writeFile(releaseFirst, 'continue');

    const firstDemand = await waitFor(async () => {
      const result = await db!.pool.query<{
        id: number; version: number; linear_issue_id: string | null; linear_sync_status: string;
      }>('SELECT id, version, linear_issue_id, linear_sync_status FROM demands WHERE project_id = $1', [projectId]);
      return result.rows[0];
    }, (demand) => Boolean(demand?.linear_issue_id && demand.version === 2 && demand.linear_sync_status === 'synced'), 'criação e atualização da issue Linear');
    assert.ok(firstDemand);
    assert.equal(firstDemand.version, 2);
    assert.ok(calls.some((call) => call.service === 'linear' && call.operation === 'create'));
    assert.deepEqual(issueLabels.map((label) => label.name).sort(),
      ['Tipo: Funcionalidade', `Projeto: ${projectName}`].sort());

    const updatedDemand = await waitFor(async () => {
      const result = await db!.pool.query<{
        id: number; version: number; title: string; requirements: string[]; linear_issue_id: string | null;
        linear_sync_status: string;
      }>('SELECT id, version, title, requirements, linear_issue_id, linear_sync_status FROM demands WHERE project_id = $1', [projectId]);
      return result.rows[0];
    }, (demand) => Boolean(demand && demand.version === 2 && demand.linear_sync_status === 'synced'), 'atualização da issue Linear');
    assert.ok(updatedDemand);
    assert.equal(updatedDemand.id, firstDemand.id);
    assert.equal(updatedDemand.linear_issue_id, 'local-issue-42');
    assert.deepEqual(updatedDemand.requirements, [
      'Exportar relatórios em Excel', 'Filtrar por data', 'Filtrar por funcionário'
    ]);
    const linearWrites = calls.filter((call) => call.service === 'linear' && ['create', 'update'].includes(call.operation));
    assert.deepEqual(linearWrites.map((call) => call.operation), ['create', 'update']);
    const updateVariables = linearWrites[1]!.body.variables as { id: string; input: { title: string; description: string } };
    assert.equal(updateVariables.id, 'local-issue-42');
    assert.equal(updateVariables.input.title, 'Exportar relatórios em Excel com filtros');
    assert.match(updateVariables.input.description, /Filtrar por data/);
    const interpretationContexts = (await readFile(inputLog, 'utf8'))
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        model: string;
        context: {
          batchMessages: Array<{ id: string; text: string; fromMe: boolean }>;
          projects: Array<{ id: number; demands: Array<{ id: number; version: number }> }>;
        };
      });
    assert.equal(interpretationContexts.length, 2, 'o webhook duplicado não gerou outra interpretação');
    assert.ok(interpretationContexts.every((item) => item.model === 'gpt-6-luna'));
    assert.equal(interpretationContexts[0]?.context.batchMessages.length, 1, 'o primeiro lote é uma visão fixa');
    assert.equal(interpretationContexts[0]?.context.batchMessages[0]?.fromMe, false);
    assert.equal(interpretationContexts[1]?.context.batchMessages.length, 1, 'a mensagem durante a análise ficou no lote seguinte');
    assert.equal(interpretationContexts[1]?.context.batchMessages[0]?.fromMe, true);

    const codexFinished = await waitFor(async () => {
      const result = await db!.pool.query<{ status: string }>(
        'SELECT status FROM codex_jobs WHERE demand_id = $1 ORDER BY demand_version DESC LIMIT 1', [firstDemand.id]
      );
      return result.rows[0]?.status;
    }, (status) => status === 'failed', 'falha controlada do Codex de teste');
    assert.equal(codexFinished, 'failed');
    assert.equal(updatedDemand.linear_issue_id, 'local-issue-42', 'falha Codex preserva o card criado');
  } finally {
    worker?.stop();
    if (app) await app.close();
    if (db) {
      if (projectId) await db.pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
      if (conversationId) await db.pool.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      if (recoveryConversationId) await db.pool.query('DELETE FROM conversations WHERE id = $1', [recoveryConversationId]);
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
    await rm(fixtureDirectory, { recursive: true, force: true });
    if (originalCodexCli === undefined) delete process.env.CODEX_CLI;
    else process.env.CODEX_CLI = originalCodexCli;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  }
});
