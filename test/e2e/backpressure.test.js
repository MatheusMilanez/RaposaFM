import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';

/**
 * Backpressure contra um destino lento, com prefetch baixo (issue #35).
 * Arquivo próprio porque o prefetch é fixado uma vez por processo — não
 * dá pra usar o mesmo ambiente do webhook-flow.test.js, que testa com
 * prefetch alto de propósito.
 */

let container;
let destServer;
let destPort;
let inFlightCount = 0;
let maxInFlight = 0;

let startAmqp, closeAmqp, isAmqpConnected;
let publishWebhook;
let startConsumer, stopConsumer;

async function waitUntil(conditionFn, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('condição não satisfeita dentro do tempo limite');
}

function baseMessage(url) {
  return {
    messageId: randomUUID(),
    url,
    payload: {},
    headers: {},
    attempt: 0,
    createdAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  container = await new RabbitMQContainer('rabbitmq:3-management').start();

  process.env.RABBITMQ_URL = container.getAmqpUrl();
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
  process.env.HTTP_TIMEOUT_MS = '5000';
  process.env.WORKER_PREFETCH = '2'; // baixo de propósito, é o que este teste mede
  process.env.ALLOW_PRIVATE_NETWORK_URLS = 'true';

  ({ startAmqp, closeAmqp, isAmqpConnected } = await import('../../src/shared/amqp.js'));
  ({ publishWebhook } = await import('../../src/api/publisher.js'));
  ({ startConsumer, stopConsumer } = await import('../../src/worker/consumer.js'));

  destServer = http.createServer((req, res) => {
    inFlightCount += 1;
    maxInFlight = Math.max(maxInFlight, inFlightCount);
    setTimeout(() => {
      inFlightCount -= 1;
      res.writeHead(200);
      res.end();
    }, 800);
  });
  await new Promise((resolve) => destServer.listen(0, '127.0.0.1', resolve));
  destPort = destServer.address().port;

  startAmqp();
  await waitUntil(() => isAmqpConnected(), { timeoutMs: 60000 });
}, 90000);

afterAll(async () => {
  await stopConsumer({ timeoutMs: 5000 }).catch(() => {});
  await closeAmqp();
  await new Promise((resolve) => destServer.close(resolve));
  await container.stop();
}, 30000);

describe('backpressure contra destino lento (#35)', () => {
  test('prefetch baixo limita quantas requisições ficam em voo ao mesmo tempo', async () => {
    // 6 mensagens, destino de 800ms, prefetch=2 -> nunca mais que 2 em
    // voo ao mesmo tempo, mesmo com 6 esperando na fila.
    for (let i = 0; i < 6; i++) {
      await publishWebhook(baseMessage(`http://127.0.0.1:${destPort}/`));
    }

    await startConsumer();
    await waitUntil(() => inFlightCount === 0 && maxInFlight > 0, { timeoutMs: 15000 });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    await stopConsumer({ timeoutMs: 5000 });
  }, 30000);

  test('a ingestão continua respondendo 202 normalmente com o backlog acumulado', async () => {
    // Publica mais 3 sem nenhum worker consumindo — a API não trava
    // nem espera a fila esvaziar, só confirma que o broker persistiu.
    for (let i = 0; i < 3; i++) {
      await expect(
        publishWebhook(baseMessage(`http://127.0.0.1:${destPort}/`))
      ).resolves.toBeUndefined();
    }
  }, 15000);
});
