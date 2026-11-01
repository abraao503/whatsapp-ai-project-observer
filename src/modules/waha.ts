import { config } from '../config.js';

interface WahaSession {
  name?: unknown;
  status?: unknown;
  me?: unknown;
}

export interface WahaConnection {
  configured: boolean;
  session: string;
  status: string;
  connected: boolean;
  account: string;
  qrDataUrl: string | null;
  detail: string;
}

export interface WahaChat {
  id: string;
  name: string;
  kind: 'contact' | 'group';
}

class WahaApiError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function wahaApiEnabled(): boolean {
  return Boolean(config.wahaApiUrl && config.wahaApiKey && config.wahaHmacKey);
}

function apiBaseUrl(): string {
  let url: URL;
  try {
    url = new URL(config.wahaApiUrl);
  } catch {
    throw new Error('WAHA_API_URL inválida');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/') {
    throw new Error('WAHA_API_URL deve apontar para a API HTTP local da VPS');
  }
  return url.origin;
}

async function wahaRequest<T>(
  apiPath: string,
  options: { method?: string; body?: unknown; accept?: string; allowNotFound?: boolean } = {}
): Promise<T | null> {
  if (!wahaApiEnabled()) throw new Error('WAHA_API_URL, WAHA_API_KEY e WAHA_HMAC_KEY precisam estar configurados');
  const headers: Record<string, string> = {
    'X-Api-Key': config.wahaApiKey,
    Accept: options.accept ?? 'application/json'
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    const request: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      signal: AbortSignal.timeout(15_000)
    };
    if (options.body !== undefined) request.body = JSON.stringify(options.body);
    response = await fetch(`${apiBaseUrl()}${apiPath}`, request);
  } catch {
    throw new Error('Não foi possível acessar a instância WAHA local');
  }
  if (options.allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    throw new WahaApiError(response.status, `WAHA respondeu HTTP ${response.status}`);
  }
  try {
    return await response.json() as T;
  } catch {
    throw new Error('WAHA retornou uma resposta inválida');
  }
}

function sessionPath(): string {
  return `/api/sessions/${encodeURIComponent(config.wahaSession)}`;
}

function sessionConfiguration() {
  return {
    name: config.wahaSession,
    config: {
      noweb: { store: { enabled: true, fullSync: false } },
      webhooks: [{
        url: `http://127.0.0.1:${config.port}/webhooks/waha`,
        events: ['message.any'],
        hmac: { key: config.wahaHmacKey },
        retries: { policy: 'constant', delaySeconds: 2, attempts: 15 }
      }]
    }
  };
}

async function getSession(): Promise<WahaSession | null> {
  return wahaRequest<WahaSession>(sessionPath(), { allowNotFound: true });
}

async function qrDataUrl(): Promise<string | null> {
  try {
    const qr = await wahaRequest<{ mimetype?: unknown; data?: unknown }>(
      `/api/${encodeURIComponent(config.wahaSession)}/auth/qr`,
      { accept: 'application/json' }
    );
    if (!qr || typeof qr.mimetype !== 'string' || !/^image\/(png|jpeg)$/.test(qr.mimetype) ||
        typeof qr.data !== 'string' || qr.data.length > 1_000_000 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(qr.data)) {
      return null;
    }
    return `data:${qr.mimetype};base64,${qr.data}`;
  } catch {
    return null;
  }
}

export async function getWahaConnection(): Promise<WahaConnection> {
  const base: WahaConnection = {
    configured: wahaApiEnabled(),
    session: config.wahaSession,
    status: 'NOT_CONFIGURED',
    connected: false,
    account: '',
    qrDataUrl: null,
    detail: ''
  };
  if (!base.configured) {
    base.detail = 'Configure a API local do WAHA e as chaves para habilitar o pareamento.';
    return base;
  }

  try {
    const session = await getSession();
    if (!session) {
      return { ...base, status: 'NOT_CREATED', detail: 'Nenhum número foi conectado nesta instância.' };
    }
    const status = typeof session.status === 'string' ? session.status : 'UNKNOWN';
    const me = session.me && typeof session.me === 'object' ? session.me as Record<string, unknown> : {};
    const account = [me.pushName, me.id].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ');
    const connected = status === 'WORKING';
    const detail = connected
      ? 'WhatsApp conectado.'
      : status === 'SCAN_QR_CODE' ? 'Leia o QR code com o WhatsApp em Dispositivos conectados.'
      : status === 'STARTING' ? 'Iniciando sessão WAHA.'
      : `Status da sessão: ${status}.`;
    return {
      ...base,
      status,
      connected,
      account,
      qrDataUrl: status === 'SCAN_QR_CODE' ? await qrDataUrl() : null,
      detail
    };
  } catch (error) {
    return {
      ...base,
      status: 'ERROR',
      detail: error instanceof Error ? error.message.slice(0, 300) : 'Falha ao consultar a instância WAHA.'
    };
  }
}

export async function connectWahaSession(): Promise<WahaConnection> {
  if (!wahaApiEnabled()) throw new Error('WAHA_API_URL, WAHA_API_KEY e WAHA_HMAC_KEY precisam estar configurados');
  const existing = await getSession();
  if (!existing) {
    try {
      await wahaRequest('/api/sessions', { method: 'POST', body: sessionConfiguration() });
    } catch (error) {
      if (!(error instanceof WahaApiError) || error.statusCode !== 409) throw error;
    }
  } else if (!['WORKING', 'STARTING', 'SCAN_QR_CODE'].includes(String(existing.status))) {
    await wahaRequest(sessionPath(), { method: 'PUT', body: sessionConfiguration() });
    await wahaRequest(`${sessionPath()}/start`, { method: 'POST', body: {} });
  }
  return getWahaConnection();
}

export async function listWahaChats(): Promise<WahaChat[]> {
  const connection = await getWahaConnection();
  if (!connection.connected) throw new Error('Conecte a sessão WAHA antes de carregar os contatos e grupos');

  const response = await wahaRequest<unknown>(
    `/api/${encodeURIComponent(config.wahaSession)}/chats/overview?limit=200&offset=0`
  );
  if (!Array.isArray(response)) throw new Error('WAHA retornou uma lista de conversas inválida');

  const chats: WahaChat[] = [];
  const seen = new Set<string>();
  for (const item of response) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const chat = item as Record<string, unknown>;
    const id = typeof chat.id === 'string' ? chat.id : '';
    if (!/^[^@\s/]+@(?:c\.us|g\.us|s\.whatsapp\.net|lid)$/.test(id) || seen.has(id)) continue;
    const name = [chat.name, chat.pushName, chat.formattedName]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
    chats.push({
      id,
      name: name ? name.slice(0, 200) : id,
      kind: id.endsWith('@g.us') ? 'group' : 'contact'
    });
    seen.add(id);
  }
  return chats;
}
