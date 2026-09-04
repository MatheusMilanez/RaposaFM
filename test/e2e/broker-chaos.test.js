import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { execSync } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Caos e resiliência contra um RabbitMQ real, reiniciado de propósito
 * no meio do teste (docker restart).
 *
 * Cobre 3 issues relacionadas, todas girando em torno do ciclo de vida
 * do container do broker:
 * - #40 durabilidade: mensagem publicada sobrevive ao restart
 * - #41 reconexão: a aplicação volta a conectar sozinha, sem intervenção
 * - #37 caos: a ingestão falha durante a queda e volta a funcionar depois
 *
 * Não usa @testcontainers/rabbitmq aqui (ao contrário de webhook-flow.test.js):
 * a porta dinâmica que o Testcontainers escolhe é renegociada a cada
 * "docker restart" neste ambiente (confirmado também com docker restart
 * bruto, fora do Testcontainers — não é um problema da biblioteca).
 * Container gerenciado manualmente com porta fixa, que sobrevive ao
 * restart de verdade.
 */

const CONTAINER_NAME = 'raposafm-e2e-chaos';
const HOST_PORT = 25992;

let destServer;
let destPort;
let destBehavior;

let startAmqp, closeAmqp, isAmqpConnected;
let publishWebhook;
let startConsumer, stopConsumer;

async function waitUntil(conditionFn, { timeoutMs = 8000, intervalMs = 300 } = {}) {
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
    payload: { origem: 'teste-caos' },
    headers: {},
    attempt: 0,
    createdAt: new Date().toISOString(),
  };
}

function dockerRm() {
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'ignore' });
  } catch {
    // ok se não existia
  }
}

beforeAll(async () => {
  dockerRm();
  execSync(
    `docker run -d --name ${CONTAINER_NAME} -p ${HOST_PORT}:5672 ` +
      `-e RABBITMQ_DEFAULT_USER=raposafm -e RABBITMQ_DEFAULT_PASS=changeme ` +
      `rabbitmq:3-management`,
    { stdio: 'ignore' }
  );

  process.env.RABBITMQ_URL = `amqp://raposafm:changeme@localhost:${HOST_PORT}`;
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
  process.env.RETRY_BACKOFF_MS = '1000,2000';
  process.env.MAX_RETRIES = '3';
  process.env.HTTP_TIMEOUT_MS = '2000';
  process.env.WORKER_PREFETCH = '10';
  process.env.ALLOW_PRIVATE_NETWORK_URLS = 'true';

  ({ startAmqp, closeAmqp, isAmqpConnected } = await import('../../src/shared/amqp.js'));
  ({ publishWebhook } = await import('../../src/api/publisher.js'));
  ({ startConsumer, stopConsumer } = await import('../../src/worker/consumer.js'));

  destBehavior = {};
  destServer = http.createServer((req, res) => {
    const behavior = destBehavior[req.url] || { status: 200 };
    behavior.count = (behavior.count || 0) + 1;
    res.writeHead(behavior.status);
    res.end();
  });
  await new Promise((resolve) => destServer.listen(0, '127.0.0.1', resolve));
  destPort = destServer.address().port;

  startAmqp();
  // Generoso: a imagem rabbitmq:3-management pode levar dezenas de
  // segundos pra aceitar conexões AMQP num ambiente sob carga.
  await waitUntil(() => isAmqpConnected(), { timeoutMs: 90000 });
}, 120000);

afterAll(async () => {
  await stopConsumer({ timeoutMs: 5000 }).catch(() => {});
  await closeAmqp();
  await new Promise((resolve) => destServer.close(resolve));
  dockerRm();
}, 30000);

describe('caos: RabbitMQ reiniciado no meio do fluxo', () => {
  test('a ingestão falha enquanto o broker está fora e volta sozinha depois (#37)', async () => {
    await waitUntil(() => isAmqpConnected(), { timeoutMs: 90000 });

    execSync(`docker restart ${CONTAINER_NAME}`, { stdio: 'ignore' });
    // A connection cai quase na hora — bem antes do container voltar a
    // aceitar conexões AMQP de novo.
    await waitUntil(() => !isAmqpConnected(), { timeoutMs: 15000 });

    const duringOutage = baseMessage(`http://127.0.0.1:${destPort}/x`);
    await expect(publishWebhook(duringOutage)).rejects.toThrow();

    await waitUntil(() => isAmqpConnected(), { timeoutMs: 90000 });

    const afterRecovery = baseMessage(`http://127.0.0.1:${destPort}/x`);
    await expect(publishWebhook(afterRecovery)).resolves.toBeUndefined();
  }, 150000);

  test('mensagem publicada antes do restart sobrevive e é entregue depois (#40)', async () => {
    await waitUntil(() => isAmqpConnected(), { timeoutMs: 90000 });
    destBehavior['/durab'] = { status: 200 };
    const message = baseMessage(`http://127.0.0.1:${destPort}/durab`);
    // publishWebhook() usa publisher confirms — este await só resolve
    // depois do broker confirmar que persistiu, então não precisa de
    // nenhuma folga artificial antes do restart.
    await publishWebhook(message);

    execSync(`docker restart ${CONTAINER_NAME}`, { stdio: 'ignore' });
    await waitUntil(() => !isAmqpConnected(), { timeoutMs: 15000 });
    await waitUntil(() => isAmqpConnected(), { timeoutMs: 90000 });

    // Só agora um worker aparece pra consumir — prova que a mensagem
    // ficou persistida na fila durante todo o restart, não em memória.
    await startConsumer();
    await waitUntil(() => destBehavior['/durab'].count === 1, { timeoutMs: 10000 });
    await stopConsumer({ timeoutMs: 5000 });
  }, 150000);

  test('depois de reconectar, a aplicação segue publicando e consumindo normalmente (#41)', async () => {
    await waitUntil(() => isAmqpConnected(), { timeoutMs: 90000 });
    destBehavior['/pos-reconexao'] = { status: 200 };
    const message = baseMessage(`http://127.0.0.1:${destPort}/pos-reconexao`);

    await startConsumer();
    await publishWebhook(message);
    await waitUntil(() => destBehavior['/pos-reconexao'].count === 1, { timeoutMs: 10000 });
    await stopConsumer({ timeoutMs: 5000 });
  }, 40000);
});
