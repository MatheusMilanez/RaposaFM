import 'dotenv/config';
import Fastify from 'fastify';
import { config } from '../shared/config.js';

/**
 * Bootstrap da API de ingestão.
 *
 * Nesta etapa (M1) o servidor apenas sobe e responde na raiz — a rota
 * de ingestão (POST /api/v1/webhooks), o healthcheck e a conexão com
 * o RabbitMQ entram na M2 (Motor de Ingestão).
 */
export function buildServer() {
  const app = Fastify({
    logger: { level: config.logLevel },
  });

  app.get('/', async () => ({
    service: 'raposafm-api',
    status: 'ok',
  }));

  return app;
}

async function start() {
  const app = buildServer();
  try {
    await app.listen({ port: config.api.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
