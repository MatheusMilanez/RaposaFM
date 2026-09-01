import 'dotenv/config';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

/**
 * Bootstrap do worker.
 *
 * Nesta etapa (M1) o processo apenas confirma que a configuração é
 * válida e fica de pé. O consumo da fila, o despacho HTTP e o
 * desligamento gracioso entram na M3 (Camada de Workers).
 */
logger.info('worker iniciado', {
  prefetch: config.worker.prefetch,
  maxRetries: config.worker.maxRetries,
});

process.on('SIGTERM', () => {
  logger.info('worker recebeu SIGTERM, encerrando');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('worker recebeu SIGINT, encerrando');
  process.exit(0);
});
