import { config } from '../config.js';
import type { Provider } from './whatsapp.js';

export class MediaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaUnavailableError';
  }
}

export class MediaDownloadHttpError extends Error {
  constructor(readonly statusCode: number, label: string) {
    super(`Download do ${label} respondeu HTTP ${statusCode}`);
    this.name = 'MediaDownloadHttpError';
  }
}

async function readMediaResponse(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > maxBytes) throw new MediaUnavailableError(`O ${label} excede o limite configurado`);
  if (!response.body) throw new MediaUnavailableError(`A resposta não contém o arquivo de ${label}`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new MediaUnavailableError(`O ${label} excede o limite configurado`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (!total) throw new MediaUnavailableError(`O arquivo de ${label} está vazio`);
  return Buffer.concat(chunks, total);
}

export async function downloadWhatsappMedia(
  provider: Provider,
  media: Record<string, unknown>,
  maxBytes: number,
  label: string
): Promise<Buffer> {
  const mediaUrl = typeof media.url === 'string' ? media.url : '';
  const apiUrl = provider === 'waha' ? config.wahaApiUrl : config.evolutionApiUrl;
  const apiKey = provider === 'waha' ? config.wahaApiKey : config.evolutionApiKey;
  if (!apiUrl || !mediaUrl) throw new MediaUnavailableError(`A mensagem não tem arquivo preservado nem URL para baixar o ${label}`);
  let mediaPath: string;
  try {
    const parsed = new URL(mediaUrl, 'http://local.invalid');
    mediaPath = parsed.pathname + parsed.search;
  } catch {
    throw new MediaUnavailableError(`URL de ${label} inválida`);
  }
  if (!mediaPath.startsWith('/api/files/')) throw new MediaUnavailableError(`A URL de ${label} não é um arquivo da API configurada`);
  const headers: Record<string, string> = {};
  if (apiKey) headers[provider === 'waha' ? 'X-Api-Key' : 'apikey'] = apiKey;
  const response = await fetch(`${apiUrl}${mediaPath}`, {
    headers,
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    if (response.status === 404) throw new MediaUnavailableError(`Download do ${label} respondeu HTTP 404; arquivo indisponível no WAHA`);
    throw new MediaDownloadHttpError(response.status, label);
  }
  return readMediaResponse(response, maxBytes, label);
}
