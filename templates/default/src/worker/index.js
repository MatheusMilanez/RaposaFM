import 'dotenv/config';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { startAmqp, closeAmqp, isAmqpConnected } from '../shared/amqp.js';
import { startConsumer, stopConsumer } from './consumer.js';

let shuttingDown = false;

async function waitUntilConnected() {
  while (!isAmqpConnected() && !shuttingDown) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Laço principal: assina a fila, espera o channel cair (conexão perdida)
 * e retoma assim que reconectar. A reconexão da connection em si é
 * responsabilidade do src/shared/amqp.js.
 */
async function run() {
  while (!shuttingDown) {
    await waitUntilConnected();
    if (shuttingDown) break;

    try {
      const { closed } = await startConsumer();
      await closed;
      if (!shuttingDown) {
        logger.warn('worker: consumo interrompido, retomando assim que reconectar');
      }
    } catch (err) {
      logger.error('worker: falha ao iniciar consumo, tentando de novo', { error: err.message });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`worker recebeu ${signal}, encerrando`);
  await stopConsumer({ timeoutMs: 10000 });
  await closeAmqp();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

logger.info('worker iniciado', {
  prefetch: config.worker.prefetch,
  maxRetries: config.worker.maxRetries,
  httpTimeoutMs: config.worker.httpTimeoutMs,
});

startAmqp();
run();
