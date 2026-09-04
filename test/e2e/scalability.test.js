import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';

/**
 * Escalabilidade horizontal (#36): vazão com 1, 2 e 3 workers sob a
 * mesma carga. Workers são processos node reais (spawn), não
 * containers — não precisamos de sinais POSIX aqui, só de processos
 * concorrentes de verdade competindo pela mesma fila.
 */

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

let container;
let rabbitmqUrl;
let destServer;
let destPort;
let arrivals = 0;

let publishWebhook;

async function waitUntil(conditionFn, { timeoutMs = 8000, intervalMs = 100 } = {}) {
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

function spawnWorkers(count) {
  const workers = [];
  for (let i = 0; i < count; i++) {
    workers.push(
      spawn('node', ['src/worker/index.js'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          RABBITMQ_URL: rabbitmqUrl,
          // Baixo de propósito: com prefetch alto, 1 worker sozinho já
          // satura a concorrência que o destino aguenta, e sobra pouco
          // espaço pra mais workers mostrarem ganho nenhum.
          WORKER_PREFETCH: '1',
          HTTP_TIMEOUT_MS: '5000',
          ALLOW_PRIVATE_NETWORK_URLS: 'true',
        },
        stdio: 'ignore',
      })
    );
  }
  return workers;
}

async function killWorkers(workers) {
  for (const w of workers) w.kill();
  // Dá tempo real do processo morrer antes da próxima rodada — evita
  // um worker da rodada anterior competir pela fila da rodada seguinte.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function measureThroughput(workerCount, messageCount) {
  const workers = spawnWorkers(workerCount);
  // Espera os processos novos conectarem e assinarem a fila antes de
  // publicar e cronometrar — senão a medição vira ruído de tempo de
  // boot/conexão (bem variável), não vazão de processamento de verdade.
  await new Promise((resolve) => setTimeout(resolve, 6000));

  arrivals = 0;
  const t0 = Date.now();
  for (let i = 0; i < messageCount; i++) {
    await publishWebhook(baseMessage(`http://127.0.0.1:${destPort}/`));
  }
  await waitUntil(() => arrivals >= messageCount, { timeoutMs: 40000 });
  const elapsedMs = Date.now() - t0;
  await killWorkers(workers);

  return messageCount / (elapsedMs / 1000);
}

beforeAll(async () => {
  container = await new RabbitMQContainer('rabbitmq:3-management').start();
  rabbitmqUrl = container.getAmqpUrl();

  process.env.RABBITMQ_URL = rabbitmqUrl;
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
  process.env.ALLOW_PRIVATE_NETWORK_URLS = 'true';
  ({ publishWebhook } = await import('../../src/api/publisher.js'));
  const { startAmqp, isAmqpConnected } = await import('../../src/shared/amqp.js');
  startAmqp();
  await waitUntil(() => isAmqpConnected(), { timeoutMs: 60000 });

  // Destino com um pouco de trabalho simulado (100ms) — rápido demais
  // e a rede/overhead do processo domina a medição, não o worker.
  destServer = http.createServer((req, res) => {
    setTimeout(() => {
      arrivals += 1;
      res.writeHead(200);
      res.end();
    }, 100);
  });
  await new Promise((resolve) => destServer.listen(0, '127.0.0.1', resolve));
  destPort = destServer.address().port;
}, 90000);

afterAll(async () => {
  const { closeAmqp } = await import('../../src/shared/amqp.js');
  await closeAmqp();
  await new Promise((resolve) => destServer.close(resolve));
  await container.stop();
}, 30000);

describe('escalabilidade horizontal dos workers (#36)', () => {
  test('vazão com 3 workers é maior que com 1, sob a mesma carga', async () => {
    const MESSAGES = 30;

    const throughput1 = await measureThroughput(1, MESSAGES);
    const throughput3 = await measureThroughput(3, MESSAGES);

    // Não exigimos ganho linear exato (ambiente de teste tem ruído
    // demais pra isso), só uma melhora real e substancial.
    expect(throughput3).toBeGreaterThan(throughput1 * 1.5);
  }, 120000);
});
