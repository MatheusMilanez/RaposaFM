import { isAmqpConnected } from '../../shared/amqp.js';
import { pingDb } from '../../shared/db.js';

/**
 * GET /health — usado por Docker, orquestradores e monitoramento.
 * Reflete o estado real das duas dependências que a ingestão precisa
 * pra aceitar um webhook: RabbitMQ (publica a entrega) e PostgreSQL
 * (registra a idempotência, M9). Não adianta responder 200 se falta
 * qualquer uma das duas.
 */
export default async function healthRoutes(app) {
  app.get('/health', async (request, reply) => {
    const rabbitmqConnected = isAmqpConnected();
    const databaseConnected = await pingDb();
    const healthy = rabbitmqConnected && databaseConnected;

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'unavailable',
      rabbitmq: rabbitmqConnected ? 'connected' : 'disconnected',
      database: databaseConnected ? 'connected' : 'disconnected',
    });
  });
}
