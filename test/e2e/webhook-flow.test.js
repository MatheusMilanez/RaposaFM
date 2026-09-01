import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';

/**
 * Teste end-to-end contra um RabbitMQ real (Testcontainers), usando o
 * código de produção de ponta a ponta: o publisher da API publica, o
 * consumer do worker consome — nada aqui é reimplementado ou mockado.
 *
 * Backoff e timeout curtos só neste ambiente de teste, pra não esperar
 * minutos reais por um cenário de retry. As variáveis de ambiente
 * precisam ser definidas ANTES do primeiro import dos módulos da
 * aplicação (config.js lê o ambiente na hora da importação) — por
 * isso os imports abaixo são dinâmicos, dentro do beforeAll.
 */

let container;
let destServer;
let destPort;
let destBehavior;

let startAmqp, closeAmqp, getChannel, isAmqpConnected;
let QUEUES;
let publishWebhook;
let startConsumer, stopConsumer;

beforeAll(async () => {
  container = await new RabbitMQContainer('rabbitmq:3-management').start();

  process.env.RABBITMQ_URL = container.getAmqpUrl();
  process.env.RETRY_BACKOFF_MS = '1000,2000';
  process.env.MAX_RETRIES = '3';
  process.env.HTTP_TIMEOUT_MS = '2000';
  process.env.WORKER_PREFETCH = '10';
  process.env.ALLOW_PRIVATE_NETWORK_URLS = 'true'; // o destino de teste é local

  ({ startAmqp, closeAmqp, getChannel, isAmqpConnected } =
    await import('../../src/shared/amqp.js'));
  ({ QUEUES } = await import('../../src/shared/topology.js'));
  ({ publishWebhook } = await import('../../src/api/publisher.js'));
  ({ startConsumer, stopConsumer } = await import('../../src/worker/consumer.js'));

  destBehavior = {};
  destServer = http.createServer((req, res) => {
    const behavior = destBehavior[req.url] || { status: 200 };
    behavior.count = (behavior.count || 0) + 1;
    const status =
      behavior.failTimes && behavior.count <= behavior.failTimes ? 500 : behavior.status;
    res.writeHead(status);
    res.end();
  });
  await new Promise((resolve) => destServer.listen(0, '127.0.0.1', resolve));
  destPort = destServer.address().port;

  startAmqp();
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (isAmqpConnected()) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  await startConsumer();
}, 90000);

afterAll(async () => {
  await stopConsumer({ timeoutMs: 5000 });
  await closeAmqp();
  await new Promise((resolve) => destServer.close(resolve));
  await container.stop();
}, 30000);

async function queueDepth(name) {
  const ch = await getChannel();
  try {
    const info = await ch.checkQueue(name);
    return info.messageCount;
  } finally {
    await ch.close();
  }
}

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
    payload: { origem: 'teste-e2e' },
    headers: {},
    attempt: 0,
    createdAt: new Date().toISOString(),
  };
}

describe('fluxo completo do webhook contra RabbitMQ real', () => {
  test('mensagem entregue com sucesso de primeira sai de todas as filas', async () => {
    destBehavior['/ok'] = { status: 200 };
    const message = baseMessage(`http://127.0.0.1:${destPort}/ok`);

    await publishWebhook(message);

    await waitUntil(async () => (await queueDepth(QUEUES.delivery)) === 0);
    expect(await queueDepth(QUEUES.wait)).toBe(0);
    expect(await queueDepth(QUEUES.dlq)).toBe(0);
    expect(destBehavior['/ok'].count).toBe(1);
  });

  test('mensagem que falha e se recupera dentro do limite termina em sucesso, sem ir pra DLQ', async () => {
    destBehavior['/recupera'] = { status: 200, failTimes: 1 };
    const message = baseMessage(`http://127.0.0.1:${destPort}/recupera`);

    await publishWebhook(message);

    // 1 falha + 1 espera de 1s (RETRY_BACKOFF_MS[0]) + sucesso na 2ª tentativa.
    await waitUntil(async () => destBehavior['/recupera'].count >= 2, { timeoutMs: 6000 });
    await waitUntil(async () => (await queueDepth(QUEUES.wait)) === 0, { timeoutMs: 6000 });

    expect(await queueDepth(QUEUES.dlq)).toBe(0);
    expect(await queueDepth(QUEUES.delivery)).toBe(0);
  });

  test('mensagem que sempre falha esgota MAX_RETRIES e termina na DLQ com o contexto do erro', async () => {
    destBehavior['/sempre-falha'] = { status: 500 };
    const message = baseMessage(`http://127.0.0.1:${destPort}/sempre-falha`);

    await publishWebhook(message);

    // MAX_RETRIES=3, backoff 1s+2s: 3 tentativas ao todo antes da DLQ.
    await waitUntil(async () => (await queueDepth(QUEUES.dlq)) === 1, { timeoutMs: 8000 });
    expect(destBehavior['/sempre-falha'].count).toBe(3);

    const ch = await getChannel();
    const dlqMsg = await ch.get(QUEUES.dlq, { noAck: true });
    await ch.close();
    const parsed = JSON.parse(dlqMsg.content.toString());
    expect(parsed.attempt).toBe(3);
    expect(parsed.lastStatus).toBe(500);
    expect(parsed.messageId).toBe(message.messageId);
  });

  test('destino totalmente fora do ar (conexão recusada) percorre todo o retry até a DLQ (#39)', async () => {
    // Porta 1 é reservada — nada escuta nela, então é uma conexão
    // recusada de verdade, não um erro HTTP. Diferente do cenário
    // "sempre 500": aqui não existe nem resposta, o TCP nem conecta.
    const message = baseMessage('http://127.0.0.1:1/');

    await publishWebhook(message);

    await waitUntil(async () => (await queueDepth(QUEUES.dlq)) === 1, { timeoutMs: 8000 });

    const ch = await getChannel();
    const dlqMsg = await ch.get(QUEUES.dlq, { noAck: true });
    await ch.close();
    const parsed = JSON.parse(dlqMsg.content.toString());
    expect(parsed.attempt).toBe(3);
    expect(parsed.messageId).toBe(message.messageId);
    // Conexão recusada não tem status HTTP nenhum pra reportar.
    expect(parsed.lastStatus).toBeNull();
    expect(parsed.lastError).toBeDefined();
  });
});
