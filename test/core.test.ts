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

test('video webhook events retain captions and video bytes without classifying them as audio', () => {
  const videoBytes = Buffer.from('video fixture');
  const parsed = parseWebhook('waha', {
    event: 'message.any',
    session: 'main',
    payload: {
      id: 'wamid.video',
      from: '15550000000@c.us',
      fromMe: false,
      type: 'video',
      body: 'Veja o erro ao salvar o relatório',
      hasMedia: true,
      media: { mimetype: 'video/mp4', url: '/api/files/video.mp4', base64: videoBytes.toString('base64') }
    }
  });

  assert.equal(parsed.messages[0]?.kind, 'video');
  assert.equal(parsed.messages[0]?.text, 'Veja o erro ao salvar o relatório');
  assert.equal(parsed.messages[0]?.audioBase64, null);
  assert.deepEqual(Buffer.from(parsed.messages[0]?.videoBase64 ?? '', 'base64'), videoBytes);
});

test('Evolution video and image payloads do not place visual media in the audio field', () => {
  const video = parseWebhook('evolution', {
    event: 'messages.upsert',
    instance: 'primary',
    data: {
      key: { remoteJid: '15550000000@s.whatsapp.net', id: 'video-1', fromMe: false },
      message: { videoMessage: { mimetype: 'video/mp4', caption: 'Veja esta tela', base64: 'dmlkZW8=' } }
    }
  }).messages[0];
  const image = parseWebhook('evolution', {
    event: 'messages.upsert',
    instance: 'primary',
    data: {
      key: { remoteJid: '15550000000@s.whatsapp.net', id: 'image-1', fromMe: false },
      message: { imageMessage: { mimetype: 'image/jpeg', base64: 'aW1hZ2U=' } }
    }
  }).messages[0];

  assert.equal(video?.kind, 'video');
  assert.equal(video?.text, 'Veja esta tela');
  assert.equal(video?.audioBase64, null);
  assert.equal(video?.videoBase64, 'dmlkZW8=');
  assert.equal('base64' in (video?.media ?? {}), false);
  assert.equal(image?.kind, 'media');
  assert.equal(image?.audioBase64, null);
  assert.equal(image?.videoBase64, null);
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
  const labels: Array<{ id: string; name: string }> = [];
  let currentIssueLabels: Array<{ id: string; name: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    if (request.query.includes('query ObserverTeamLabels')) {
      operations.push({ name: 'labels', variables: request.variables });
      return new Response(JSON.stringify({ data: { issueLabels: { nodes: labels } } }), { status: 200 });
    }
    if (request.query.includes('mutation CreateObserverLabel')) {
      operations.push({ name: 'create-label', variables: request.variables });
      const input = request.variables.input as { name: string };
      const label = { id: `label-${labels.length + 1}`, name: input.name };
      labels.push(label);
      return new Response(JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: label } } }), { status: 200 });
    }
    if (request.query.includes('query ObserverIssueLabels')) {
      operations.push({ name: 'issue-labels', variables: request.variables });
      return new Response(JSON.stringify({ data: { issue: { labels: { nodes: currentIssueLabels } } } }), { status: 200 });
    }
    if (request.query.includes('mutation UpdateObserverIssueLabels')) {
      operations.push({ name: 'update-labels', variables: request.variables });
      const input = request.variables.input as { labelIds: string[] };
      currentIssueLabels = labels.filter((label) => input.labelIds.includes(label.id));
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 });
    }
    if (request.query.includes('query FindObserverIssue')) {
      operations.push({ name: 'find', variables: request.variables });
      return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), { status: 200 });
    }
    if (request.query.includes('mutation CreateObserverIssue')) {
      operations.push({ name: 'create', variables: request.variables });
      const input = request.variables.input as { labelIds: string[] };
      currentIssueLabels = labels.filter((label) => input.labelIds.includes(label.id));
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
    assert.ok(operations.some((operation) => operation.name === 'find'));
    const createOperation = operations.find((operation) => operation.name === 'create')!;
    const createInput = createOperation.variables.input as { description: string; labelIds: string[] };
    assert.equal(createInput.labelIds.length, 2);
    assert.deepEqual(currentIssueLabels.map((label) => label.name), ['Tipo: Funcionalidade', 'Projeto: Projeto de teste']);
    const createdDescription = createInput.description;
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
      demandType: 'bug',
      summary: 'Exportar em Excel e filtrar os dados por data e funcionário.',
      requirements: [
        'Exportar relatório no formato Excel',
        'Filtrar por data e funcionário'
      ],
      acceptanceCriteria: ['O arquivo Excel contém apenas as linhas dos filtros selecionados'],
      conversationContext: 'Cliente confirmou Excel e acrescentou filtros de data e funcionário.',
      linearIssueId: created.id
    };
    const manualLabel = { id: 'manual-priority', name: 'Prioridade manual' };
    labels.push(manualLabel);
    currentIssueLabels.push(manualLabel);
    const updated = await createOrUpdateIssue(refined, project);
    assert.equal(updated.id, created.id);
    assert.equal(operations.filter((operation) => operation.name === 'create').length, 1);
    const updateVariables = operations.findLast((operation) => operation.name === 'update')!.variables;
    assert.equal(updateVariables.id, 'issue-101');
    assert.equal((updateVariables.input as { title: string }).title, refined.title);
    assert.match((updateVariables.input as { description: string }).description, /Filtrar por data e funcionário/);
    assert.deepEqual(currentIssueLabels.map((label) => label.name).sort(),
      ['Prioridade manual', 'Projeto: Projeto de teste', 'Tipo: Bug'].sort());
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
  const labels: Array<{ id: string; name: string }> = [];
  let currentIssueLabels: Array<{ id: string; name: string }> = [];
  let createCalls = 0;
  let updateCalls = 0;

  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    if (request.query.includes('query ObserverTeamLabels')) {
      return new Response(JSON.stringify({ data: { issueLabels: { nodes: labels } } }), { status: 200 });
    }
    if (request.query.includes('mutation CreateObserverLabel')) {
      const input = request.variables.input as { name: string };
      const label = { id: `label-${labels.length + 1}`, name: input.name };
      labels.push(label);
      return new Response(JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: label } } }), { status: 200 });
    }
    if (request.query.includes('query ObserverIssueLabels')) {
      return new Response(JSON.stringify({ data: { issue: { labels: { nodes: currentIssueLabels } } } }), { status: 200 });
    }
    if (request.query.includes('mutation UpdateObserverIssueLabels')) {
      const input = request.variables.input as { labelIds: string[] };
      currentIssueLabels = labels.filter((label) => input.labelIds.includes(label.id));
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 });
    }
    if (request.query.includes('query FindObserverIssue')) {
      const found = issue.description.includes('whatsapp-ai-project-observer:demand:88');
      return new Response(JSON.stringify({ data: { issues: { nodes: found ? [issue] : [] } } }), { status: 200 });
    }
    if (request.query.includes('mutation CreateObserverIssue')) {
      createCalls += 1;
      const input = request.variables.input as { title: string; description: string };
      issue.title = input.title;
      issue.description = input.description;
      currentIssueLabels = labels;
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
