import { getChannel } from '../shared/amqp.js';
import { assertTopology, QUEUES } from '../shared/topology.js';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { dispatch } from './dispatcher.js';
import { decideOutcome, publishToDlq, publishToWait } from './retryPolicy.js';
import { completeTask, markTaskDead } from '../db/taskQueue.js';

/**
 * Registra o desfecho da tarefa no PostgreSQL (M9) — quem decide
 * retry vs. DLQ continua sendo o RabbitMQ (decideOutcome/backoff), isso
 * aqui só espelha a decisão final na linha da tabela `tasks`. Nunca deve
 * afetar o ack/retry da mensagem: falhar em gravar no banco não pode
 * causar reentrega ao destino, que já recebeu (ou definitivamente não
 * vai receber) o webhook.
 */
async function recordOutcome(fn, { messageId, ...fields }) {
  try {
    await fn({ id: messageId, ...fields });
  } catch (err) {
    logger.error('worker: falha ao registrar o desfecho da tarefa no banco', {
      messageId,
      error: err.message,
    });
  }
}

let channel = null;
let consumerTag = null;
let inFlight = 0;

// Exportada só para teste unitário (test/unit/consumer.test.js, com
// channel fake e dispatch mockado) — o resto de consumer.js depende
// demais da semântica real do amqplib pra valer a pena mockar.
export async function handleMessage(ch, msg) {
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
      await recordOutcome(completeTask, {
        messageId: message.messageId,
        result: { status: result.status, latencyMs: result.latencyMs },
      });
      ch.ack(msg);
      return;
    }

    const decision = decideOutcome(message, result);
    if (decision.action === 'retry') {
      await publishToWait(ch, message, result, decision);
    } else {
      await publishToDlq(ch, message, result, { attempt: decision.nextAttempt });
      await recordOutcome(markTaskDead, {
        messageId: message.messageId,
        errorMessage: result.error,
      });
      logger.warn('worker: mensagem enviada para a DLQ', {
        messageId: message.messageId,
        motivo: decision.reason,
      });
    }
    ch.ack(msg); // só confirma depois do broker ter confirmado o próximo destino
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
