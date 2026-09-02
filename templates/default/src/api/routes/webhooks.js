import { randomUUID } from 'node:crypto';
import { publishWebhook } from '../publisher.js';
import { assertPublicUrl, SsrfError } from '../../shared/ssrfGuard.js';

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
 * Valida o payload, publica na fila de entrega e responde 202 em poucos
 * milissegundos. Não entrega o webhook aqui — isso é responsabilidade
 * do worker (M3). Se o broker estiver indisponível, responde 503 e
 * nunca 202: o cliente sabe que precisa tentar de novo.
 *
 * A validação de URL inclui a defesa contra SSRF (esquema, IP privado,
 * DNS) — ver src/shared/ssrfGuard.js. O worker revalida de novo antes
 * de cada tentativa de despacho, porque o backoff pode espaçar
 * tentativas por minutos: tempo de sobra pra um DNS rebinding.
 */
export default async function webhooksRoutes(app) {
  app.post('/api/v1/webhooks', { schema: { body: bodySchema } }, async (request, reply) => {
    const { url, payload, headers } = request.body;

    try {
      await assertPublicUrl(url);
    } catch (err) {
      if (err instanceof SsrfError) {
        return reply.code(400).send({ error: `url inválida: ${err.message}` });
      }
      throw err;
    }

    const messageId = randomUUID();
    const message = {
      messageId,
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

    return reply.code(202).send({ messageId });
  });
}
