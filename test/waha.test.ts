import assert from 'node:assert/strict';
import test from 'node:test';

process.env.WAHA_API_URL = 'http://127.0.0.1:3201';
process.env.WAHA_API_KEY = 'test-waha-api-key-123456789';
process.env.WAHA_HMAC_KEY = 'test-webhook-hmac-key-123456789';
process.env.WAHA_SESSION = 'observer';
process.env.PORT = '3105';

const wahaModule = import('../src/modules/waha.js');
const originalFetch = globalThis.fetch;
const imageData = Buffer.from('test-qr-image').toString('base64');

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('WAHA onboarding creates one persisted session with signed message.any webhook and returns the QR', async () => {
  const { connectWahaSession } = await wahaModule;
  const calls: Array<{ url: string; method: string; headers: Headers; body: Record<string, unknown> | null }> = [];
  let sessionReads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url, method: init?.method ?? 'GET', headers, body });
    if (url.endsWith('/api/sessions/observer') && calls.at(-1)?.method === 'GET') {
      sessionReads += 1;
      return sessionReads === 1
        ? new Response('', { status: 404 })
        : jsonResponse({ name: 'observer', status: 'SCAN_QR_CODE', me: null });
    }
    if (url.endsWith('/api/sessions') && calls.at(-1)?.method === 'POST') {
      return jsonResponse({ name: 'observer', status: 'STARTING' }, 201);
    }
    if (url.endsWith('/api/observer/auth/qr')) {
      assert.equal(headers.get('accept'), 'application/json');
      return jsonResponse({ mimetype: 'image/png', data: imageData });
    }
    throw new Error(`Unexpected WAHA request ${init?.method} ${url}`);
  }) as typeof fetch;

  try {
    const connection = await connectWahaSession();
    assert.equal(connection.status, 'SCAN_QR_CODE');
    assert.equal(connection.connected, false);
    assert.equal(connection.qrDataUrl, `data:image/png;base64,${imageData}`);

    const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/api/sessions'));
    assert.ok(create);
    assert.equal(create.headers.get('x-api-key'), process.env.WAHA_API_KEY);
    const session = create.body?.config as {
      noweb: { store: { enabled: boolean; fullSync: boolean } };
      webhooks: Array<{ url: string; events: string[]; hmac: { key: string } }>;
    };
    assert.deepEqual(session.noweb.store, { enabled: true, fullSync: false });
    assert.equal(session.webhooks[0]?.url, 'http://127.0.0.1:3105/webhooks/waha');
    assert.deepEqual(session.webhooks[0]?.events, ['message.any']);
    assert.equal(session.webhooks[0]?.hmac.key, process.env.WAHA_HMAC_KEY);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WAHA chat picker returns contact and group identifiers without message content', async () => {
  const { listWahaChats } = await wahaModule;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/sessions/observer')) {
      return jsonResponse({ name: 'observer', status: 'WORKING', me: null });
    }
    if (url.includes('/api/observer/chats/overview?')) {
      return jsonResponse([
        { id: '5511999999999@c.us', name: 'Cliente', lastMessage: { body: 'Conteúdo privado' } },
        { id: '120363000000000000@g.us', name: 'Projeto', lastMessage: { body: 'Outra mensagem' } },
        { id: '12345@newsletter', name: 'Canal' },
        { id: '5511999999999@c.us', name: 'Duplicado' },
        { id: '', name: 'Inválido' }
      ]);
    }
    throw new Error(`Unexpected WAHA request ${url}`);
  }) as typeof fetch;

  try {
    const chats = await listWahaChats();
    assert.deepEqual(chats, [
      { id: '5511999999999@c.us', name: 'Cliente', kind: 'contact' },
      { id: '120363000000000000@g.us', name: 'Projeto', kind: 'group' }
    ]);
    assert.equal(JSON.stringify(chats).includes('Conteúdo privado'), false);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WAHA connect does not restart an already connected number', async () => {
  const { connectWahaSession } = await wahaModule;
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (url.endsWith('/api/sessions/observer')) {
      return jsonResponse({ name: 'observer', status: 'WORKING', me: { id: '5511999999999@c.us', pushName: 'Conta de teste' } });
    }
    throw new Error(`Unexpected WAHA request ${method} ${url}`);
  }) as typeof fetch;

  try {
    const connection = await connectWahaSession();
    assert.equal(connection.connected, true);
    assert.equal(connection.status, 'WORKING');
    assert.equal(connection.account, 'Conta de teste · 5511999999999@c.us');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.method === 'GET'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WAHA status hides API and webhook secrets from its response', async () => {
  const { getWahaConnection } = await wahaModule;
  globalThis.fetch = (async () => jsonResponse({ name: 'observer', status: 'WORKING', me: null })) as typeof fetch;
  try {
    const result = await getWahaConnection();
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(process.env.WAHA_API_KEY!), false);
    assert.equal(serialized.includes(process.env.WAHA_HMAC_KEY!), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
