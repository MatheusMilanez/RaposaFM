import { logger } from './logger.js';

/**
 * Nomes centralizados da topologia AMQP. Nenhum outro módulo deve usar
 * string literal de exchange, fila ou routing key — sempre importar daqui.
 */
export const EXCHANGE = 'raposafm.dispatch';

export const QUEUES = Object.freeze({
  delivery: 'raposafm.delivery',
  wait: 'raposafm.wait',
  dlq: 'raposafm.dlq',
});

export const ROUTING_KEYS = Object.freeze({
  deliver: 'deliver',
  wait: 'wait',
  dlq: 'dlq',
});

/**
 * Declara a topologia. Idempotente — seguro de rodar em todo start da
 * API e de cada worker contra um RabbitMQ zerado.
 *
 * - EXCHANGE (direct, durável): recebe toda publicação e roteia por routing key.
 * - QUEUES.delivery: fila de entrega, consumida pelos workers (M3).
 * - QUEUES.wait: fila de espera do retry (M4). O TTL é definido por mensagem
 *   na publicação (propriedade `expiration`), não na fila — por isso uma
 *   única fila de espera serve para qualquer passo do backoff. Ao expirar,
 *   a mensagem é devolvida ao exchange com a routing key de entrega.
 * - QUEUES.dlq: destino final das mensagens que esgotaram as tentativas (M4).
 *   O worker publica nela explicitamente; não é ligada por dead-lettering
 *   automático da fila de entrega.
 */
export async function assertTopology(channel) {
  await channel.assertExchange(EXCHANGE, 'direct', { durable: true });

  await channel.assertQueue(QUEUES.delivery, { durable: true });
  await channel.bindQueue(QUEUES.delivery, EXCHANGE, ROUTING_KEYS.deliver);

  await channel.assertQueue(QUEUES.wait, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': EXCHANGE,
      'x-dead-letter-routing-key': ROUTING_KEYS.deliver,
    },
  });
  await channel.bindQueue(QUEUES.wait, EXCHANGE, ROUTING_KEYS.wait);

  await channel.assertQueue(QUEUES.dlq, { durable: true });
  await channel.bindQueue(QUEUES.dlq, EXCHANGE, ROUTING_KEYS.dlq);

  logger.info('amqp: topologia declarada', { exchange: EXCHANGE, filas: Object.values(QUEUES) });
}
