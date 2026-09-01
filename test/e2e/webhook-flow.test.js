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
let dispatch;

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
  ({ dispatch } = await import('../../src/worker/dispatcher.js'));

  destBehavior = {};
  destServer = http.createServer((req, res) => {
    const behavior = destBehavior[req.url] || { status: 200 };
    behavior.count = (behavior.count || 0) + 1;
    const status =
      behavior.failTimes && behavior.count <= behavior.failTimes ? 500 : behavior.status;
    setTimeout(() => {
      behavior.onArrival?.();
      res.writeHead(status);
      res.end();
    }, behavior.delayMs || 0);
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

  test('ack perdido depois de uma entrega bem-sucedida causa duplicata — cliente precisa ser idempotente (#32)', async () => {
    // Reproduz de forma determinística (sem depender de cronometrar um
    // SIGKILL): consome a mensagem manualmente, despacha de verdade
    // (dispatch() real, o destino recebe e responde 200), mas fecha o
    // channel ANTES de confirmar — exatamente o que acontece se o
    // worker morrer entre a entrega e o ack. O RabbitMQ, sem receber a
    // confirmação, devolve a mensagem pra fila sozinho.
    //
    // O beforeAll já deixa um consumer de fundo rodando pro resto da
    // suíte — precisa parar ele aqui, senão ele pega a mensagem antes
    // do ch1.get() manual conseguir.
    await stopConsumer({ timeoutMs: 5000 });

    destBehavior['/idempotencia'] = { status: 200 };
    const message = baseMessage(`http://127.0.0.1:${destPort}/idempotencia`);
    await publishWebhook(message);

    const ch1 = await getChannel();
    await ch1.prefetch(1);
    let msg;
    await waitUntil(
      async () => {
        msg = await ch1.get(QUEUES.delivery, { noAck: false });
        return Boolean(msg);
      },
      { timeoutMs: 5000 }
    );
    const parsedMsg = JSON.parse(msg.content.toString());
    const result = await dispatch(parsedMsg);
    expect(result.outcome).toBe('success');
    expect(destBehavior['/idempotencia'].count).toBe(1); // 1ª entrega, de verdade
    await ch1.close(); // "morre" sem confirmar — simula o crash

    await waitUntil(async () => (await queueDepth(QUEUES.delivery)) === 1, { timeoutMs: 10000 });

    // Um worker normal processa a mensagem redevolvida — o destino
    // recebe a MESMA mensagem uma segunda vez. Não para o consumer nesse
    // ponto: o beforeAll deixou ele rodando pro resto da suíte, e os
    // testes seguintes dependem disso.
    await startConsumer();
    await waitUntil(() => destBehavior['/idempotencia'].count === 2, { timeoutMs: 10000 });

    expect(destBehavior['/idempotencia'].count).toBe(2); // duplicata real, não simulada
  }, 30000);

  test('múltiplos workers concorrentes não garantem ordem de entrega (#33)', async () => {
    // 5 mensagens publicadas na ordem 0,1,2,3,4, cada uma pra uma rota
    // com delay decrescente — a mensagem 4 responde na hora, a 0 demora
    // mais. Com prefetch alto (todas em voo ao mesmo tempo), a ordem de
    // chegada no destino deveria ser o inverso da ordem de publicação.
    const N = 5;
    const arrivalOrder = [];
    for (let i = 0; i < N; i++) {
      destBehavior[`/ordem-${i}`] = {
        status: 200,
        delayMs: (N - 1 - i) * 300,
        onArrival: () => arrivalOrder.push(i),
      };
    }

    for (let i = 0; i < N; i++) {
      await publishWebhook(baseMessage(`http://127.0.0.1:${destPort}/ordem-${i}`));
    }

    await waitUntil(() => arrivalOrder.length === N, { timeoutMs: 10000 });

    expect(arrivalOrder).not.toEqual([0, 1, 2, 3, 4]); // não manteve a ordem de publicação
    expect(arrivalOrder).toEqual([4, 3, 2, 1, 0]); // inverteu, como o delay desenhado previa
    expect(new Set(arrivalOrder).size).toBe(N); // todas chegaram, nenhuma perdida
  }, 20000);
});
