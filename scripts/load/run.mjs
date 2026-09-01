#!/usr/bin/env node
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Orquestra um teste de carga completo: sobe o compose + o destino
 * local de teste, roda o script k6 pedido, derruba tudo no final.
 *
 * Uso: node scripts/load/run.mjs [ingest|stress]
 */

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const scriptName = process.argv[2] || 'ingest';
const PROJECT_NAME = 'raposafm-load';
const API_PORT = 3098;

const composeEnv = {
  ...process.env,
  RABBITMQ_USER: 'raposafm',
  RABBITMQ_PASSWORD: 'loadtest',
  API_PORT: String(API_PORT),
};

function compose(args) {
  execSync(
    `docker compose -p ${PROJECT_NAME} -f docker-compose.yml -f docker-compose.load.yml ${args}`,
    { cwd: projectRoot, env: composeEnv, stdio: 'inherit' }
  );
}

async function waitHealthy() {
  const start = Date.now();
  while (Date.now() - start < 90000) {
    try {
      const res = await fetch(`http://localhost:${API_PORT}/health`);
      if (res.status === 200) return;
    } catch {
      // ainda não subiu, tenta de novo
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('API não ficou saudável a tempo');
}

try {
  compose('down -v');
} catch {
  // ok se não existia nada rodando
}

console.log(`\n=== subindo a stack de carga ===`);
compose('up -d --build');

try {
  await waitHealthy();
  console.log(`\n=== rodando k6: ${scriptName}.js ===`);
  execSync(
    `docker run --rm --network ${PROJECT_NAME}_default -e API_URL=http://api:${API_PORT} ` +
      `-v "${path.join(projectRoot, 'scripts/load')}:/scripts" grafana/k6 run /scripts/${scriptName}.js`,
    { stdio: 'inherit' }
  );
} finally {
  console.log(`\n=== derrubando a stack de carga ===`);
  compose('down -v');
}
