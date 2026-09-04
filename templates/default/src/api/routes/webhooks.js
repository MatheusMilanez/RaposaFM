import { publishWebhook } from '../publisher.js';
import { assertPublicUrl, SsrfError } from '../../shared/ssrfGuard.js';
import { enqueue } from '../../db/taskQueue.js';

const TASK_QUEUE_NAME = 'webhooks';

const bodySchema = {
  type: 'object',
  required: ['url', 'payload'],
  additionalProperties: false,
  properties: {
    url: { type: 'string', minLength: 1 },
    payload: {},
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
};

/**
 * POST /api/v1/webhooks — porta de entrada do sistema.
 *
 * Valida o payload, registra a tarefa no PostgreSQL (motor de
 * idempotência, M9) e publica na fila de entrega, respondendo 202 em
 * poucos milissegundos. Não entrega o webhook aqui — isso é
 * responsabilidade do worker (M3). Se o banco ou o broker estiverem
 * indisponíveis, responde 503 e nunca 202: o cliente sabe que precisa
 * tentar de novo.
 *
 * Um header `Idempotency-Key` opcional evita reentrega quando o mesmo
 * pedido chega mais de uma vez (retry de rede do cliente, por exemplo):
 * a chave já vista faz enqueue() devolver a tarefa original sem criar
 * linha nova, e a rota pula a publicação — quem já foi aceito uma vez
 * não é publicado de novo.
 *
 * A validação de URL inclui a defesa contra SSRF (esquema, IP privado,
 * DNS) — ver src/shared/ssrfGuard.js. O worker revalida de novo antes
 * de cada tentativa de despacho, porque o backoff pode espaçar
 * tentativas por minutos: tempo de sobra pra um DNS rebinding.
 */
export default async function webhooksRoutes(app) {
  app.post('/api/v1/webhooks', { schema: { body: bodySchema } }, async (request, reply) => {
    const { url, payload, headers } = request.body;
    const idempotencyKey = request.headers['idempotency-key'] || null;

    try {
      await assertPublicUrl(url);
    } catch (err) {
      if (err instanceof SsrfError) {
        return reply.code(400).send({ error: `url inválida: ${err.message}` });
      }
      throw err;
    }

    let task;
    try {
      task = await enqueue({
        queueName: TASK_QUEUE_NAME,
        payload: { url, payload, headers: headers || {} },
        idempotencyKey,
      });
    } catch (err) {
      request.log.error({ err }, 'falha ao registrar a tarefa no banco');
      return reply.code(503).send({
        error: 'banco de dados indisponível no momento, tente novamente em instantes',
      });
    }

    if (!task.created) {
      return reply.code(202).send({ messageId: task.id });
    }

    const message = {
      messageId: task.id,
      url,
      payload,
      headers: headers || {},
      attempt: 0,
      createdAt: new Date().toISOString(),
    };

    try {
      await publishWebhook(message);
    } catch (err) {
      request.log.error({ err }, 'falha ao publicar na fila');
      return reply.code(503).send({
        error: 'broker indisponível no momento, tente novamente em instantes',
      });
    }

    return reply.code(202).send({ messageId: task.id });
  });
}
