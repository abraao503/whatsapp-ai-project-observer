import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { config, validateConfig } from './config.js';
import { initializeDatabase, pool, recordError } from './db/index.js';
import { registerAdminRoutes } from './admin.js';
import { noteWebhook, ingestMessages } from './modules/whatsapp-store.js';
import { parseWebhook, type Provider } from './modules/whatsapp.js';
import { secureEquals, verifyWahaHmac } from './modules/webhook-security.js';
import { openAiStatus, validateModelAccess } from './modules/openai.js';
import { startWorker } from './jobs/worker.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function evolutionEventBody(body: unknown, pathEvent?: string): unknown {
  if (!pathEvent || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const value = body as Record<string, unknown>;
  if (value.event) return body;
  return { ...value, event: pathEvent.replaceAll('-', '.') };
}

async function handleWebhook(
  reply: FastifyReply,
  provider: Provider,
  body: unknown
): Promise<unknown> {
  let parsed: ReturnType<typeof parseWebhook>;
  try {
    parsed = parseWebhook(provider, body);
  } catch (error) {
    await recordError('webhook:format', error, { provider });
    return reply.code(400).send({ error: 'Formato de evento inválido' });
  }
  try {
    await noteWebhook(provider);
    if (!parsed.eventAccepted) return reply.code(200).send({ received: true, ignored: true });
    if (parsed.messages.length > 200) return reply.code(413).send({ error: 'Evento excede 200 mensagens por chamada' });
    const summary = await ingestMessages(parsed.messages);
    return reply.code(202).send({ received: true, ...summary });
  } catch (error) {
    await recordError('webhook:persist', error, { provider });
    return reply.code(503).send({ error: 'A mensagem ainda não foi persistida; o webhook pode tentar novamente' });
  }
}

export function createApp(): FastifyInstance {
  const app = Fastify({
    logger: config.nodeEnv === 'test' ? false : {
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
      serializers: {
        req(request) {
          const url = typeof request.url === 'string' ? request.url : '';
          return {
            method: request.method,
            url: url.startsWith('/webhooks/evolution/') ? '/webhooks/evolution/:token' : url,
            hostname: request.hostname,
            remoteAddress: request.ip
          };
        }
      }
    },
    bodyLimit: Math.max(2_000_000, Math.ceil(config.maxAudioBytes * 1.6))
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: Math.max(2_000_000, Math.ceil(config.maxAudioBytes * 1.6)) },
    (request, body, done) => {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
      request.rawBody = raw;
      try {
        done(null, JSON.parse(raw.toString('utf8')));
      } catch {
        done(new Error('JSON inválido'));
      }
    }
  );

  app.get('/health', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', model: openAiStatus().state };
    } catch {
      return reply.code(503).send({ status: 'database_unavailable' });
    }
  });

  app.post<{ Params: { token: string; event?: string } }>('/webhooks/evolution/:token', async (request, reply) => {
    if (!config.evolutionWebhookToken) return reply.code(503).send({ error: 'Evolution webhook não configurado' });
    if (!secureEquals(config.evolutionWebhookToken, request.params.token)) return reply.code(401).send({ error: 'Token inválido' });
    return handleWebhook(reply, 'evolution', request.body);
  });

  app.post<{ Params: { token: string; event: string } }>('/webhooks/evolution/:token/:event', async (request, reply) => {
    if (!config.evolutionWebhookToken) return reply.code(503).send({ error: 'Evolution webhook não configurado' });
    if (!secureEquals(config.evolutionWebhookToken, request.params.token)) return reply.code(401).send({ error: 'Token inválido' });
    const body = evolutionEventBody(request.body, request.params.event);
    return handleWebhook(reply, 'evolution', body);
  });

  app.post('/webhooks/waha', async (request, reply) => {
    if (!config.wahaHmacKey) return reply.code(503).send({ error: 'WAHA webhook HMAC não configurado' });
    const signature = headerValue(request.headers['x-webhook-hmac']);
    const algorithm = headerValue(request.headers['x-webhook-hmac-algorithm']);
    if (!request.rawBody || !verifyWahaHmac(request.rawBody, signature, algorithm, config.wahaHmacKey)) {
      return reply.code(401).send({ error: 'Assinatura WAHA inválida' });
    }
    return handleWebhook(reply, 'waha', request.body);
  });

  registerAdminRoutes(app);

  return app;
}

async function main(): Promise<void> {
  validateConfig();
  await initializeDatabase();
  const app = createApp();

  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info({ address }, 'whatsapp observer online');
  const worker = startWorker();

  void validateModelAccess().then((status) => {
    if (status.state === 'available') app.log.info({ model: status.model }, 'OpenAI model validated');
    else app.log.warn({ model: status.model, state: status.state, detail: status.detail }, 'OpenAI model unavailable; batches remain pending');
  }).catch((error) => recordError('openai:model-check', error));

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    worker.stop();
    await app.close();
    await pool.end();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[startup] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
