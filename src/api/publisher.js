import { getChannel, isAmqpConnected } from '../shared/amqp.js';
import { assertTopology, EXCHANGE, ROUTING_KEYS } from '../shared/topology.js';
import { logger } from '../shared/logger.js';

/**
 * Publisher da API: mantém um único channel reaproveitado entre requisições
 * ("um channel por contexto de uso" — este é o contexto "ingestão").
 * Se o channel cair, a próxima publicação recria tudo do zero.
 */
let channel = null;
let settingUp = null;

async function ensureChannel() {
  if (channel) return channel;
  if (settingUp) return settingUp;

  settingUp = (async () => {
    const ch = await getChannel();
    ch.on('close', () => {
      logger.warn('publisher: channel encerrado, será recriado na próxima publicação');
      channel = null;
    });
    ch.on('error', (err) => {
      logger.error('publisher: erro no channel', { error: err.message });
    });
    await assertTopology(ch);
    channel = ch;
    return ch;
  })();

  try {
    return await settingUp;
  } finally {
    settingUp = null;
  }
}

/**
 * Publica a mensagem de webhook na fila de entrega.
 * Lança erro se o broker estiver indisponível ou o channel estiver com
 * o buffer cheio — a rota decide responder 503 nesses casos.
 */
export async function publishWebhook(message) {
  const ch = await ensureChannel();

  const ok = ch.publish(EXCHANGE, ROUTING_KEYS.deliver, Buffer.from(JSON.stringify(message)), {
    persistent: true,
    contentType: 'application/json',
    messageId: message.messageId,
  });

  if (!ok) {
    throw new Error('buffer do channel AMQP cheio, tente novamente');
  }
}

export function isPublisherReady() {
  return isAmqpConnected();
}
