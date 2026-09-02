import { isAmqpConnected } from '../../shared/amqp.js';

/**
 * GET /health — usado por Docker, orquestradores e monitoramento.
 * Reflete o estado real da conexão com o RabbitMQ: não adianta a API
 * responder 200 se ela não consegue publicar nada.
 */
export default async function healthRoutes(app) {
  app.get('/health', async (request, reply) => {
    const connected = isAmqpConnected();
    return reply.code(connected ? 200 : 503).send({
      status: connected ? 'ok' : 'unavailable',
      rabbitmq: connected ? 'connected' : 'disconnected',
    });
  });
}
