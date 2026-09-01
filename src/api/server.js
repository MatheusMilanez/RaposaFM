import 'dotenv/config';
import Fastify from 'fastify';
import { config } from '../shared/config.js';
import { startAmqp, closeAmqp } from '../shared/amqp.js';
import healthRoutes from './routes/health.js';
import webhooksRoutes from './routes/webhooks.js';

export function buildServer() {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Fastify remove campos extras silenciosamente por padrão (removeAdditional:
    // true), mesmo com additionalProperties:false no schema. Desligamos isso
    // para que campo desconhecido vire 400, não descarte silencioso.
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.get('/', async () => ({
    service: 'raposafm-api',
    status: 'ok',
  }));

  app.register(healthRoutes);
  app.register(webhooksRoutes);

  return app;
}

async function start() {
  const app = buildServer();

  // A conexão AMQP sobe em segundo plano e se reconecta sozinha; a API
  // não trava esperando o broker no boot. Enquanto não conectar, /health
  // responde 503 e a ingestão responde 503 a cada tentativa de publicar.
  startAmqp();

  const shutdown = async (signal) => {
    app.log.info(`recebido ${signal}, encerrando`);
    await app.close();
    await closeAmqp();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await app.listen({ port: config.api.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
