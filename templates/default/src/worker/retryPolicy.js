import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { publishConfirmed } from '../shared/amqp.js';
import { EXCHANGE, ROUTING_KEYS } from '../shared/topology.js';

/**
 * Decide o que fazer com uma mensagem que falhou.
 *
 * - Falha não-retryable (4xx, exceto 408/429): direto pra DLQ. Não
 *   adianta insistir num erro que o destino já disse que é definitivo.
 * - Falha retryable (5xx, 408, 429, timeout, erro de rede): soma mais
 *   uma tentativa. Se ainda não estourou MAX_RETRIES, agenda o reenvio
 *   com o próximo degrau do backoff. Se estourou, vai pra DLQ.
 */
export function decideOutcome(message, result) {
  if (result.retryable === false) {
    return { action: 'dlq', reason: 'falha permanente' };
  }

  const nextAttempt = (message.attempt || 0) + 1;
  if (nextAttempt >= config.worker.maxRetries) {
    return { action: 'dlq', reason: 'tentativas esgotadas', nextAttempt };
  }

  const schedule = config.worker.backoffScheduleMs;
  const step = Math.min(nextAttempt - 1, schedule.length - 1);
  return { action: 'retry', nextAttempt, delayMs: schedule[step] };
}

function withFailureContext(message, result) {
  return {
    ...message,
    lastError: result.error,
    lastStatus: result.status,
    lastAttemptAt: new Date().toISOString(),
  };
}

/**
 * Publica a mensagem esgotada/permanentemente falha na DLQ, para
 * inspeção. Só resolve depois do broker confirmar (publisher confirms)
 * — mesma razão do publisher da API, ver shared/amqp.js.
 */
export async function publishToDlq(ch, message, result, { attempt } = {}) {
  const failedMessage = {
    ...withFailureContext(message, result),
    ...(attempt !== undefined ? { attempt } : {}),
  };
  await publishConfirmed(
    ch,
    EXCHANGE,
    ROUTING_KEYS.dlq,
    Buffer.from(JSON.stringify(failedMessage)),
    { persistent: true, contentType: 'application/json', messageId: message.messageId }
  );
}

/**
 * Agenda o reenvio: publica na fila de espera com o TTL do degrau atual
 * (propriedade `expiration`, por mensagem — não é TTL fixo da fila). Ao
 * expirar, o RabbitMQ devolve a mensagem para a fila de entrega sozinho.
 * Só resolve depois do broker confirmar a publicação.
 */
export async function publishToWait(ch, message, result, { nextAttempt, delayMs }) {
  const retryMessage = { ...withFailureContext(message, result), attempt: nextAttempt };
  await publishConfirmed(
    ch,
    EXCHANGE,
    ROUTING_KEYS.wait,
    Buffer.from(JSON.stringify(retryMessage)),
    {
      persistent: true,
      contentType: 'application/json',
      messageId: message.messageId,
      expiration: String(delayMs),
    }
  );
  logger.info('worker: retry agendado', {
    messageId: message.messageId,
    tentativa: nextAttempt,
    emMs: delayMs,
  });
}
