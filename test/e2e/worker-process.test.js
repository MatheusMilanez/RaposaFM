import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { execSync } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Worker rodando de verdade num container Linux — igual à validação
 * manual da M3, agora automatizada. SIGTERM/SIGKILL não existem como
 * sinais POSIX reais no Windows nativo (process.on('SIGTERM') nunca
 * dispara via kill externo por lá), então "matar o processo de
 * verdade" só é testável de forma confiável dentro de um container.
 *
 * - #38: docker kill (SIGKILL) com mensagem em voo — não perde a
 *   mensagem, ela volta pra fila sozinha e outro worker a processa.
 * - #42: docker stop (SIGTERM) com várias mensagens em voo — espera
 *   todas terminarem antes de sair, não perde nem duplica.
 *
 * RabbitMQ gerenciado na mão (não @testcontainers/rabbitmq): o worker
 * roda num container separado e precisa alcançar o broker via
 * host.docker.internal, não "localhost" — e o usuário guest padrão do
 * RabbitMQ só aceita login vindo de localhost literal. Definir
 * RABBITMQ_DEFAULT_USER/PASS explicitamente (como abaixo) desliga essa
 * restrição, igual ao broker-chaos.test.js.
 */

const RABBIT_CONTAINER_NAME = 'raposafm-e2e-worker-process-rabbit';
const RABBIT_HOST_PORT = 25993;

let rabbitmqUrlFromHost;
let rabbitmqUrlFromContainer;
let destServer;
let destPort;
let destBehavior;

let getChannel, closeAmqp, startAmqp, isAmqpConnected;
let publishWebhook;
let QUEUES;

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
    payload: { origem: 'teste-worker-process' },
    headers: {},
    attempt: 0,
    createdAt: new Date().toISOString(),
  };
}

async function queueDepth(name) {
  const ch = await getChannel();
  try {
    const info = await ch.checkQueue(name);
    return info.messageCount;
  } finally {
    await ch.close();
  }
}

function dockerRm(name) {
  try {
    execSync(`docker rm -f ${name}`, { stdio: 'ignore' });
  } catch {
    // ok se não existia
  }
}

function runWorkerContainer(name, { httpTimeoutMs = 5000 } = {}) {
  dockerRm(name);
  execSync(
    `docker run -d --name ${name} ` +
      `--add-host host.docker.internal:host-gateway ` +
      `-e RABBITMQ_URL=${rabbitmqUrlFromContainer} ` +
      `-e RETRY_BACKOFF_MS=1000,2000 ` +
      `-e MAX_RETRIES=3 ` +
      `-e HTTP_TIMEOUT_MS=${httpTimeoutMs} ` +
      `-e WORKER_PREFETCH=10 ` +
      `-e ALLOW_PRIVATE_NETWORK_URLS=true ` +
      `-v "${process.cwd()}:/app" -w /app ` +
      `node:22-alpine node src/worker/index.js`,
    { stdio: 'ignore' }
  );
}

beforeAll(async () => {
  dockerRm(RABBIT_CONTAINER_NAME);
  execSync(
    `docker run -d --name ${RABBIT_CONTAINER_NAME} -p ${RABBIT_HOST_PORT}:5672 ` +
      `-e RABBITMQ_DEFAULT_USER=raposafm -e RABBITMQ_DEFAULT_PASS=changeme ` +
      `rabbitmq:3-management`,
    { stdio: 'ignore' }
  );
  rabbitmqUrlFromHost = `amqp://raposafm:changeme@localhost:${RABBIT_HOST_PORT}`;
  rabbitmqUrlFromContainer = `amqp://raposafm:changeme@host.docker.internal:${RABBIT_HOST_PORT}`;

  process.env.RABBITMQ_URL = rabbitmqUrlFromHost;
  process.env.ALLOW_PRIVATE_NETWORK_URLS = 'true';

  ({ getChannel, closeAmqp, startAmqp, isAmqpConnected } =
    await import('../../src/shared/amqp.js'));
  ({ publishWebhook } = await import('../../src/api/publisher.js'));
  ({ QUEUES } = await import('../../src/shared/topology.js'));

  destBehavior = {};
  destServer = http.createServer((req, res) => {
    const behavior = destBehavior[req.url] || { status: 200, delayMs: 0 };
    behavior.count = (behavior.count || 0) + 1;
    setTimeout(() => {
      res.writeHead(behavior.status);
      res.end();
    }, behavior.delayMs || 0);
  });
  // 0.0.0.0, não 127.0.0.1: precisa ser alcançável a partir de dentro
  // do container do worker, via host.docker.internal.
  await new Promise((resolve) => destServer.listen(0, '0.0.0.0', resolve));
  destPort = destServer.address().port;

  startAmqp();
  await waitUntil(() => isAmqpConnected(), { timeoutMs: 60000 });
}, 90000);

afterAll(async () => {
  await closeAmqp();
  await new Promise((resolve) => destServer.close(resolve));
  dockerRm(RABBIT_CONTAINER_NAME);
}, 30000);

describe('worker rodando em container real, morto de propósito', () => {
  test('SIGKILL com mensagem em voo: ela volta pra fila e é processada depois (#38)', async () => {
    const name = 'raposafm-e2e-sigkill';
    const name2 = 'raposafm-e2e-sigkill-2';
    // try/finally: se uma asserção falhar no meio, os containers ainda
    // são removidos — um worker "zumbi" sobrevivendo entre testes rouba
    // mensagem do teste seguinte (foi exatamente o que aconteceu antes
    // desta correção).
    try {
      destBehavior['/lento-kill'] = { status: 200, delayMs: 4000 };
      const message = baseMessage(`http://host.docker.internal:${destPort}/lento-kill`);
      await publishWebhook(message);

      runWorkerContainer(name, { httpTimeoutMs: 8000 });
      // Espera o worker pegar a mensagem (a requisição HTTP começa
      // antes dela terminar, então o contador sobe assim que tenta).
      await waitUntil(() => destBehavior['/lento-kill'].count >= 1, { timeoutMs: 20000 });

      execSync(`docker kill ${name}`, { stdio: 'ignore' }); // SIGKILL, sem chance de graça
      dockerRm(name);

      // A mensagem não foi confirmada — o RabbitMQ detecta a conexão
      // morta e devolve pra fila sozinho.
      await waitUntil(async () => (await queueDepth(QUEUES.delivery)) === 1, { timeoutMs: 30000 });

      // Um segundo worker (limpo) processa a mensagem redevolvida. Só
      // ajusta o delay, não troca o objeto inteiro — trocar zeraria o
      // contador de chamadas junto.
      destBehavior['/lento-kill'].delayMs = 0;
      runWorkerContainer(name2);
      await waitUntil(() => destBehavior['/lento-kill'].count >= 2, { timeoutMs: 20000 });
      await waitUntil(async () => (await queueDepth(QUEUES.delivery)) === 0, { timeoutMs: 10000 });
    } finally {
      dockerRm(name);
      dockerRm(name2);
    }
  }, 90000);

  test('SIGTERM com mensagens em voo: espera todas terminarem antes de sair, sem perder nem duplicar (#42)', async () => {
    const name = 'raposafm-e2e-sigterm';
    try {
      destBehavior['/lento-term'] = { status: 200, delayMs: 3000 };

      const messages = [1, 2, 3].map(() =>
        baseMessage(`http://host.docker.internal:${destPort}/lento-term`)
      );
      for (const m of messages) await publishWebhook(m);

      runWorkerContainer(name, { httpTimeoutMs: 8000 });
      // Espera as 3 mensagens estarem de fato em voo (prefetch=10 pega
      // todas de uma vez).
      await waitUntil(() => destBehavior['/lento-term'].count >= 3, { timeoutMs: 20000 });

      const t0 = Date.now();
      execSync(`docker stop --timeout 15 ${name}`, { stdio: 'ignore' }); // SIGTERM, 15s de graça
      const stopMs = Date.now() - t0;

      const exitCode = execSync(`docker inspect ${name} --format="{{.State.ExitCode}}"`)
        .toString()
        .trim();

      // Parou depois de esperar a entrega (delayMs=3000), não na hora.
      expect(stopMs).toBeGreaterThan(2000);
      expect(exitCode).toBe('0'); // saída limpa via process.exit(0), não morto à força

      // As 3 mensagens foram confirmadas — nenhuma sobrou pra reentrega.
      await waitUntil(async () => (await queueDepth(QUEUES.delivery)) === 0, { timeoutMs: 10000 });
      expect(destBehavior['/lento-term'].count).toBe(3); // nenhuma duplicata
    } finally {
      dockerRm(name);
    }
  }, 90000);
});
