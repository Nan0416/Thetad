import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config';
import { Engine } from './engine';

const config = loadConfig();
const engine = new Engine(config);

const app = Fastify({ logger: true });

app.get('/api/health', async () => ({ ok: true, name: 'thetad', version: '0.0.1' }));

app.get('/api/status', async () => engine.status());

// SSE: the UI's live feed. Streams only ever carry data outward;
// all actions go through REST, all decisions happen in the engine loop.
app.get('/api/events', (request, reply) => {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event: { type: string; data: unknown }) => {
    reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };
  send({ type: 'hello', data: engine.status() });
  const unsubscribe = engine.onEvent(send);
  const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
  request.raw.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// In production the built web UI is baked into static files served here;
// in development the Vite dev server proxies /api to this daemon instead.
const webDist = resolve(import.meta.dirname, '../../web/dist');
if (existsSync(webDist)) {
  app.register(fastifyStatic, { root: webDist });
}

try {
  // Binding the port doubles as the single-daemon guard: a second instance
  // gets EADDRINUSE and exits before its engine loop ever starts.
  await app.listen({ host: '127.0.0.1', port: config.port });
  engine.start();
  app.log.info(`thetad daemon up: http://127.0.0.1:${config.port} (${config.mode})`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    app.log.error(
      `port ${config.port} is already in use — is another thetad daemon running? ` +
        'Refusing to start a second engine against the same account.',
    );
    process.exit(1);
  }
  throw error;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    engine.stop();
    await app.close();
    process.exit(0);
  });
}
