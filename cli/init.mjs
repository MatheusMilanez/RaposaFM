import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { scaffold } from './scaffold.mjs';

function randomPassword() {
  // 9 bytes -> 12 caracteres em base64url, sem símbolo que dê problema
  // dentro de um .env ou de uma URL amqp://.
  return randomBytes(9).toString('base64url');
}

function parseArgs(args) {
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  const positional = args.filter((a) => !a.startsWith('-'));
  return {
    yes: flags.has('--yes') || flags.has('-y'),
    force: flags.has('--force'),
    projectNameArg: positional[0],
  };
}

async function ask(rl, question, fallback) {
  const answer = (await rl.question(`${question} (${fallback}): `)).trim();
  return answer || fallback;
}

/**
 * Fluxo do `raposafm init`. Só pergunta o essencial — nome do projeto,
 * porta da API, usuário e senha do RabbitMQ. O resto vem dos padrões
 * do próprio .env.example, ajustável depois na mão.
 */
export async function runInit(args) {
  const { yes, force, projectNameArg } = parseArgs(args);
  const defaultName = projectNameArg || 'raposafm-app';

  let answers;
  if (yes) {
    answers = {
      projectName: defaultName,
      apiPort: '3000',
      rabbitUser: 'raposafm',
      rabbitPassword: randomPassword(),
    };
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const projectName = await ask(rl, 'Nome do projeto', defaultName);
      const apiPort = await ask(rl, 'Porta da API', '3000');
      const rabbitUser = await ask(rl, 'Usuário do RabbitMQ', 'raposafm');
      const rabbitPassword = await ask(rl, 'Senha do RabbitMQ', randomPassword());
      answers = { projectName, apiPort, rabbitUser, rabbitPassword };
    } finally {
      rl.close();
    }
  }

  const targetDir = path.resolve(process.cwd(), answers.projectName);

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !force) {
    console.error(
      `\nA pasta "${answers.projectName}" já existe e não está vazia. Use --force pra sobrescrever.`
    );
    process.exitCode = 1;
    return;
  }

  mkdirSync(targetDir, { recursive: true });
  scaffold(targetDir, answers);

  // O Dockerfile roda `npm ci`, que exige um package-lock.json — sem
  // isso, o primeiro `docker compose up --build` do usuário quebra.
  // --package-lock-only gera só o lock, sem baixar node_modules aqui
  // (o container faz isso na build).
  console.log('\nGerando package-lock.json...');
  try {
    execFileSync('npm', ['install', '--package-lock-only', '--silent'], {
      cwd: targetDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    console.warn(
      `\nNão consegui gerar o package-lock.json automaticamente (${err.message}).\n` +
        `Rode "npm install" dentro de ${answers.projectName} antes do docker compose up.`
    );
  }

  console.log(`\nProjeto criado em ./${answers.projectName}\n`);
  console.log('Próximos passos:');
  console.log(`  cd ${answers.projectName}`);
  console.log('  docker compose up -d');
  console.log(`  curl http://localhost:${answers.apiPort}/health`);
  console.log('');
}
