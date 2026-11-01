import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { nextProcessAfter, retryDelayMs, shouldStartNewBatch } from '../src/batching.js';
import { parseWebhook, normalizeDemandTitle } from '../src/modules/whatsapp.js';
import { verifyWahaHmac } from '../src/modules/webhook-security.js';

const baseTime = new Date('2026-01-01T10:00:00.000Z');

test('debounce extends on activity but is capped from the first message', () => {
  const first = { firstReceivedAt: baseTime, lastReceivedAt: baseTime };
  assert.equal(
    nextProcessAfter(first, 90_000, 300_000).toISOString(),
    '2026-01-01T10:01:30.000Z'
  );

  const active = {
    firstReceivedAt: baseTime,
    lastReceivedAt: new Date(baseTime.getTime() + 240_000)
  };
  assert.equal(
    nextProcessAfter(active, 90_000, 300_000).toISOString(),
    '2026-01-01T10:05:00.000Z'
  );
});

test('batch capacity rolls the next message into a new batch', () => {
  assert.equal(shouldStartNewBatch(29, 30), false);
  assert.equal(shouldStartNewBatch(30, 30), true);
});

test('job retry delay grows exponentially and stops at one hour', () => {
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(3), 240_000);
  assert.equal(retryDelayMs(20), 3_600_000);
});

test('WAHA message.any preserves own replies and group authorship', () => {
  const parsed = parseWebhook('waha', {
    event: 'message.any',
    session: 'main',
    payload: {
      id: 'wamid.1',
      timestamp: 1_767_268_800,
      from: '15550000000@c.us',
      to: '120363000000000000@g.us',
      chatId: '120363000000000000@g.us',
      fromMe: true,
      participant: '15550000000@c.us',
      type: 'chat',
      body: 'Inclua filtro por funcionário',
      hasMedia: false
    }
  });

  assert.equal(parsed.eventAccepted, true);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0]?.remoteJid, '120363000000000000@g.us');
  assert.equal(parsed.messages[0]?.fromMe, true);
  assert.equal(parsed.messages[0]?.senderJid, '15550000000@c.us');
  assert.equal(parsed.messages[0]?.text, 'Inclua filtro por funcionário');
});

test('WAHA voice notes are retained as audio messages', () => {
  const parsed = parseWebhook('waha', {
    event: 'message',
    session: 'main',
    payload: {
      id: 'wamid.audio',
      from: '15550000000@c.us',
      fromMe: false,
      type: 'ptt',
      hasMedia: true,
      media: { mimetype: 'audio/ogg; codecs=opus', url: '/api/files/audio.ogg' }
    }
  });

  assert.equal(parsed.messages[0]?.kind, 'audio');
  assert.equal(parsed.messages[0]?.media.url, '/api/files/audio.ogg');
});

test('Evolution messages.upsert preserves sent messages and batches array events', () => {
  const parsed = parseWebhook('evolution', {
    event: 'messages.upsert',
    instance: 'primary',
    data: [
      {
        key: { remoteJid: '120363000000000000@g.us', participant: '1@s.whatsapp.net', id: 'm1', fromMe: false },
        pushName: 'Cliente',
        messageTimestamp: 1_767_268_800,
        message: { conversation: 'Exportar relatórios' }
      },
      {
        key: { remoteJid: '120363000000000000@g.us', participant: '2@s.whatsapp.net', id: 'm2', fromMe: true },
        messageTimestamp: 1_767_268_820,
        message: { extendedTextMessage: { text: 'Em Excel e CSV' } }
      }
    ]
  });

  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0]?.text, 'Exportar relatórios');
  assert.equal(parsed.messages[1]?.fromMe, true);
  assert.equal(parsed.messages[1]?.senderJid, '2@s.whatsapp.net');
});

test('unrelated Evolution events are ignored', () => {
  assert.deepEqual(parseWebhook('evolution', { event: 'connection.update' }), {
    eventAccepted: false,
    messages: []
  });
});

test('WAHA HMAC authenticates exact webhook body and rejects altered signatures', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"event":"message.any"}');
  const signature = createHmac('sha512', secret).update(body).digest('hex');

  assert.equal(verifyWahaHmac(body, signature, 'sha512', secret), true);
  assert.equal(verifyWahaHmac(body, signature, 'sha256', secret), false);
  assert.equal(verifyWahaHmac(body, signature, 'sha512', 'wrong-secret'), false);
});

test('demand title normalization is accent and punctuation insensitive', () => {
  assert.equal(normalizeDemandTitle('Exportação de Relatórios!'), 'exportacao de relatorios');
});

test('mock WhatsApp request creates a Linear card and a later refinement edits the same card', async () => {
  const event = parseWebhook('evolution', {
    event: 'messages.upsert',
    instance: 'local-mock',
    data: {
      key: { remoteJid: '5511999999999@s.whatsapp.net', id: 'mock-001', fromMe: false },
      pushName: 'Cliente de teste',
      messageTimestamp: '2026-10-31T10:00:00.000Z',
      message: { conversation: 'Precisamos exportar os relatórios em Excel.' }
    }
  });
  assert.equal(event.messages[0]?.text, 'Precisamos exportar os relatórios em Excel.');

  const previousLinearApiKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = 'local-test-key';
  const operations: Array<{ name: string; variables: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    if (request.query.includes('query FindObserverIssue')) {
      operations.push({ name: 'find', variables: request.variables });
      return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), { status: 200 });
    }
    if (request.query.includes('mutation CreateObserverIssue')) {
      operations.push({ name: 'create', variables: request.variables });
      return new Response(JSON.stringify({
        data: { issueCreate: { success: true, issue: {
          id: 'issue-101', identifier: 'OBS-101', url: 'https://linear.local/OBS-101',
          title: (request.variables.input as { title: string }).title
        } } }
      }), { status: 200 });
    }
    if (request.query.includes('mutation UpdateObserverIssue')) {
      operations.push({ name: 'update', variables: request.variables });
      return new Response(JSON.stringify({
        data: { issueUpdate: { success: true, issue: {
          id: 'issue-101', identifier: 'OBS-101', url: 'https://linear.local/OBS-101',
          title: (request.variables.input as { title: string }).title
        } } }
      }), { status: 200 });
    }
    throw new Error('Operação Linear inesperada');
  };

  try {
    const { createOrUpdateIssue } = await import('../src/modules/linear.js');
    const initial = {
      id: 77,
      title: 'Exportar relatórios em Excel',
      summary: event.messages[0]!.text,
      demandType: 'feature',
      status: 'ready',
      requirements: ['Exportar relatório no formato Excel'],
      acceptanceCriteria: ['O arquivo abre como planilha Excel'],
      openQuestions: [],
      conversationContext: event.messages[0]!.text,
      technicalAnalysis: '',
      linearIssueId: null
    };
    const project = { name: 'Projeto de teste', linearTeamId: 'team-test', linearProjectId: 'project-test' };
    const created = await createOrUpdateIssue(initial, project);
    assert.equal(created.id, 'issue-101');
    assert.deepEqual(operations.map((operation) => operation.name), ['find', 'create']);
    const createdDescription = (operations[1]!.variables.input as { description: string }).description;
    assert.match(createdDescription, /### Objetivo e escopo/);
    assert.match(createdDescription, /### Requisitos/);
    assert.match(createdDescription, /### Critérios de aceite/);
    assert.match(createdDescription, /### Contexto e decisões/);
    assert.match(createdDescription, /### Tipo\nFuncionalidade/);
    assert.doesNotMatch(createdDescription, /### Dúvidas pendentes|Não identificado/);
    assert.ok(createdDescription.length > 150 && createdDescription.length < 3_000);

    const refined = {
      ...initial,
      title: 'Exportar relatórios em Excel com filtros',
      summary: 'Exportar em Excel e filtrar os dados por data e funcionário.',
      requirements: [
        'Exportar relatório no formato Excel',
        'Filtrar por data e funcionário'
      ],
      acceptanceCriteria: ['O arquivo Excel contém apenas as linhas dos filtros selecionados'],
      conversationContext: 'Cliente confirmou Excel e acrescentou filtros de data e funcionário.',
      linearIssueId: created.id
    };
    const updated = await createOrUpdateIssue(refined, project);
    assert.equal(updated.id, created.id);
    assert.deepEqual(operations.map((operation) => operation.name), ['find', 'create', 'update']);
    const updateVariables = operations[2]!.variables;
    assert.equal(updateVariables.id, 'issue-101');
    assert.equal((updateVariables.input as { title: string }).title, refined.title);
    assert.match((updateVariables.input as { description: string }).description, /Filtrar por data e funcionário/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousLinearApiKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = previousLinearApiKey;
  }
});

test('Linear retry finds a card created before a simulated timeout instead of creating a duplicate', async () => {
  const previousLinearApiKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = 'local-test-key';
  const originalFetch = globalThis.fetch;
  const issue = {
    id: 'issue-after-timeout',
    identifier: 'OBS-88',
    url: 'https://linear.local/OBS-88',
    title: 'Exportar histórico',
    description: ''
  };
  let createCalls = 0;
  let updateCalls = 0;

  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    if (request.query.includes('query FindObserverIssue')) {
      const found = issue.description.includes('whatsapp-ai-project-observer:demand:88');
      return new Response(JSON.stringify({ data: { issues: { nodes: found ? [issue] : [] } } }), { status: 200 });
    }
    if (request.query.includes('mutation CreateObserverIssue')) {
      createCalls += 1;
      const input = request.variables.input as { title: string; description: string };
      issue.title = input.title;
      issue.description = input.description;
      throw new Error('timeout depois de gravar a issue no servidor');
    }
    if (request.query.includes('mutation UpdateObserverIssue')) {
      updateCalls += 1;
      const variables = request.variables as { id: string; input: { title: string; description: string } };
      issue.title = variables.input.title;
      issue.description = variables.input.description;
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true, issue } } }), { status: 200 });
    }
    throw new Error('Operação Linear inesperada');
  };

  try {
    const { createOrUpdateIssue } = await import('../src/modules/linear.js');
    const demand = {
      id: 88,
      title: 'Exportar histórico de pedidos',
      summary: 'Permitir que o operador exporte o histórico de pedidos.',
      demandType: 'feature',
      status: 'ready',
      requirements: ['Gerar arquivo de exportação'],
      acceptanceCriteria: ['O arquivo contém pedidos do período selecionado'],
      openQuestions: [],
      conversationContext: 'Pedido registrado em uma conversa simulada.',
      technicalAnalysis: '',
      linearIssueId: null
    };
    const project = { name: 'Projeto de teste', linearTeamId: 'team-test', linearProjectId: '' };

    await assert.rejects(createOrUpdateIssue(demand, project), /timeout depois de gravar/);
    const reconciled = await createOrUpdateIssue(demand, project);
    assert.equal(reconciled.id, 'issue-after-timeout');
    assert.equal(createCalls, 1);
    assert.equal(updateCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousLinearApiKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = previousLinearApiKey;
  }
});
