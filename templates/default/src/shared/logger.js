import { config } from './config.js';

/**
 * Logger mínimo e estruturado, compartilhado entre API e worker.
 * A API usa o logger nativo do Fastify (baseado em Pino); este módulo
 * cobre o worker e qualquer script fora do ciclo de vida do Fastify.
 */
function log(level, message, meta = {}) {
  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

const levels = ['debug', 'info', 'warn', 'error'];
const minLevelIndex = levels.indexOf(config.logLevel);

export const logger = Object.fromEntries(
  levels.map((level) => [
    level,
    (message, meta) => {
      if (levels.indexOf(level) >= minLevelIndex) log(level, message, meta);
    },
  ])
);
