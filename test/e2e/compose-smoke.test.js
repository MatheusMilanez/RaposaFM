import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Smoke test do docker-compose.yml de verdade — não uma stack paralela
 * de teste. Valida a promessa central de developer experience do
 * README: "docker compose up -d" numa máquina limpa entrega o sistema
 * funcionando, sem passo manual escondido.
 *
 * Projeto e porta isolados (-p raposafm-smoke-test, API_PORT=3099) pra
 * não colidir com uma instância de desenvolvimento que porventura
 * esteja rodando. RABBITMQ_USER/PASSWORD passados como variável de
 * ambiente do processo, não via .env — CI não tem (nem deveria ter)
 * um .env commitado.
 *
 * Usa https://httpbin.org como destino do webhook: é a única forma de
 * testar entrega de verdade sem complicar o compose com rede extra
 * pro worker alcançar um destino local. Também prova, de quebra, que
 * o container tem saída real pra internet.
 */

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const PROJECT_NAME = 'raposafm-smoke-test';
const API_PORT = 3099;

const composeEnv = {
  ...process.env,
  RABBITMQ_USER: 'raposafm',
  RABBITMQ_PASSWORD: 'smoketest',
  API_PORT: String(API_PORT),
};

function compose(args) {
  execSync(`docker compose -p ${PROJECT_NAME} ${args}`, {
    cwd: projectRoot,
    env: composeEnv,
    stdio: 'ignore',
  });
}

async function waitUntil(conditionFn, { timeoutMs = 8000, intervalMs = 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('condição não satisfeita dentro do tempo limite');
}

beforeAll(() => {
  compose('down -v'); // limpa qualquer resíduo de uma execução anterior
  compose('up -d --build');
}, 180000);

afterAll(() => {
  try {
    compose('down -v');
  } catch {
    // segue o baile — não queremos que uma falha de limpeza mascare o
    // resultado real do teste
  }
}, 60000);

describe('docker compose up -d entrega o sistema funcionando (#43)', () => {
  test('/health fica 200 dentro de um tempo razoável, sem passo manual', async () => {
    await waitUntil(
      async () => {
        try {
          const res = await fetch(`http://localhost:${API_PORT}/health`);
          return res.status === 200;
        } catch {
          return false;
        }
      },
      { timeoutMs: 90000 }
    );
  }, 100000);

  test('uma requisição de teste é aceita e efetivamente entregue', async () => {
    const res = await fetch(`http://localhost:${API_PORT}/api/v1/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://httpbin.org/status/200', payload: { smoke: true } }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.messageId).toBeDefined();

    await waitUntil(
      () => {
        const logs = execSync(`docker compose -p ${PROJECT_NAME} logs worker`, {
          cwd: projectRoot,
          env: composeEnv,
        }).toString();
        return logs.includes(body.messageId) && logs.includes('entrega bem-sucedida');
      },
      { timeoutMs: 30000 }
    );
  }, 40000);
});
