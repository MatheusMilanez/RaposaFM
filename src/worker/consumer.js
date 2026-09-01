import { getChannel } from '../shared/amqp.js';
import { assertTopology, QUEUES } from '../shared/topology.js';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { dispatch } from './dispatcher.js';
import { decideOutcome, publishToDlq, publishToWait } from './retryPolicy.js';

let channel = null;
let consumerTag = null;
let inFlight = 0;

async function handleMessage(ch, msg) {
  inFlight += 1;
  try {
    let message;
    try {
      message = JSON.parse(msg.content.toString());
    } catch (err) {
      logger.error('worker: mensagem malformada, descartando (não é reprocessável)', {
        error: err.message,
      });
      ch.ack(msg);
      return;
    }

    const result = await dispatch(message);

    if (result.outcome === 'success') {
      ch.ack(msg);
      return;
    }

    const decision = decideOutcome(message, result);
    if (decision.action === 'retry') {
      publishToWait(ch, message, result, decision);
    } else {
      publishToDlq(ch, message, result, decision);
      logger.warn('worker: mensagem enviada para a DLQ', {
        messageId: message.messageId,
        motivo: decision.reason,
      });
    }
    ch.ack(msg); // a mensagem já está segura no próximo destino (wait ou DLQ)
  } finally {
    inFlight -= 1;
  }
}

/**
 * Abre um channel, aplica o prefetch e começa a consumir a fila de
 * entrega. Retorna { closed }, uma promise que resolve quando o channel
 * cai (conexão perdida) — quem chama usa isso para saber quando retomar.
 */
export async function startConsumer() {
  const ch = await getChannel();
  await ch.prefetch(config.worker.prefetch);
  await assertTopology(ch);

  const closed = new Promise((resolve) => {
    ch.once('close', () => resolve());
  });
  ch.on('error', (err) => {
    logger.error('worker: erro no channel de consumo', { error: err.message });
  });

  const { consumerTag: tag } = await ch.consume(QUEUES.delivery, (msg) => {
    if (!msg) return; // consumo cancelado pelo broker
    handleMessage(ch, msg).catch((err) => {
      logger.error('worker: erro inesperado processando mensagem, devolvendo para a fila', {
        error: err.message,
      });
      ch.nack(msg, false, true);
    });
  });

  channel = ch;
  consumerTag = tag;
  logger.info('worker: consumindo', { fila: QUEUES.delivery, prefetch: config.worker.prefetch });

  return { closed };
}

/**
 * Para de aceitar mensagens novas e aguarda as que já estão em voo
 * terminarem, até o timeout. Usado no desligamento gracioso (SIGTERM).
 */
export async function stopConsumer({ timeoutMs = 10000 } = {}) {
  if (channel && consumerTag) {
    await channel.cancel(consumerTag).catch(() => {});
  }

  const start = Date.now();
  while (inFlight > 0 && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (inFlight > 0) {
    logger.warn('worker: encerrando com mensagens ainda em voo', { inFlight });
  }
  consumerTag = null;
}
