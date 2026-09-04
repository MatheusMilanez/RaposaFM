import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { runInit } from '../../cli/init.mjs';

/**
 * Testa o resultado real do `raposafm init`, não só os arquivos copiados:
 * roda o scaffolding de verdade num diretório temporário (com npm de
 * verdade gerando o lockfile) e verifica a árvore final, a substituição
 * dos placeholders, o .env e se o código gerado passa no lint do próprio
 * projeto — a mesma config usada por `npm run lint` na raiz.
 */

const eslintConfigPath = fileURLToPath(new URL('../../eslint.config.js', import.meta.url));

let baseDir;
let originalCwd;

beforeAll(() => {
  originalCwd = process.cwd();
  baseDir = mkdtempSync(path.join(tmpdir(), 'raposafm-scaffold-'));
  process.chdir(baseDir);
  // O `runInit` real imprime o passo a passo pro usuário no terminal —
  // ruído aqui, não sinal. As asserções checam arquivo e process.exitCode,
  // não a saída no console.
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
  process.chdir(originalCwd);
  rmSync(baseDir, { recursive: true, force: true });
});

describe('raposafm init (#25)', () => {
  let projectDir;

  beforeAll(async () => {
    await runInit(['projeto-padrao', '--yes']);
    projectDir = path.join(baseDir, 'projeto-padrao');
  }, 30000);

  test('gera exatamente a árvore de arquivos esperada', () => {
    expect(readdirSync(projectDir).sort()).toEqual(
      [
        '.dockerignore',
        '.env',
        '.env.example',
        '.gitignore',
        'Dockerfile',
        'docker-compose.yml',
        'package-lock.json',
        'package.json',
        'readme.md',
        'src',
      ].sort()
    );
  });

  test('substitui __PROJECT_NAME__ nos arquivos gerados', () => {
    const pkg = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('projeto-padrao');

    const readme = readFileSync(path.join(projectDir, 'readme.md'), 'utf8');
    expect(readme).toContain('projeto-padrao');
    expect(readme).not.toContain('__PROJECT_NAME__');
  });

  test('.env tem todas as variáveis do .env.example', () => {
    const keysOf = (content) => [...content.matchAll(/^([A-Z_]+)=/gm)].map(([, key]) => key).sort();

    const example = readFileSync(path.join(projectDir, '.env.example'), 'utf8');
    const generated = readFileSync(path.join(projectDir, '.env'), 'utf8');

    expect(keysOf(generated)).toEqual(keysOf(example));

    const user = generated.match(/^RABBITMQ_USER=(.+)$/m)[1];
    const password = generated.match(/^RABBITMQ_PASSWORD=(.+)$/m)[1];
    expect(generated).toMatch(
      new RegExp(`^RABBITMQ_URL=amqp://${user}:${password}@localhost:5672$`, 'm')
    );

    const pgUser = generated.match(/^POSTGRES_USER=(.+)$/m)[1];
    const pgPassword = generated.match(/^POSTGRES_PASSWORD=(.+)$/m)[1];
    expect(pgPassword).not.toBe('changeme');
    expect(generated).toMatch(
      new RegExp(`^DATABASE_URL=postgres://${pgUser}:${pgPassword}@localhost:5432/raposafm$`, 'm')
    );
  });

  test('package-lock.json de verdade foi gerado (npm ci não quebra)', () => {
    const lockfile = JSON.parse(readFileSync(path.join(projectDir, 'package-lock.json'), 'utf8'));
    expect(lockfile.packages['']).toBeDefined();
  });

  test('o código gerado passa no lint do próprio projeto', async () => {
    const eslint = new ESLint({ overrideConfigFile: eslintConfigPath, cwd: projectDir });
    const results = await eslint.lintFiles([path.join(projectDir, 'src/**/*.js')]);
    const errors = results.flatMap((r) => r.messages.filter((m) => m.severity === 2));

    if (errors.length > 0) {
      const formatter = await eslint.loadFormatter('stylish');
      throw new Error(await formatter.format(results));
    }
    expect(errors).toHaveLength(0);
  }, 20000);
});

describe('diretório de destino não vazio', () => {
  const dirName = 'ocupado';
  let dir;

  beforeAll(() => {
    dir = path.join(baseDir, dirName);
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'marcador.txt'), 'não mexer');
  });

  test('sem --force, recusa sobrescrever e não altera o conteúdo existente', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runInit([dirName, '--yes']);
      expect(process.exitCode).toBe(1);
      expect(readdirSync(dir)).toEqual(['marcador.txt']);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  test('com --force, escreve o projeto por cima', async () => {
    await runInit([dirName, '--yes', '--force']);
    expect(existsSync(path.join(dir, 'package.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'src'))).toBe(true);
  }, 20000);
});

describe('--yes usa senha aleatória', () => {
  test('duas execuções geram senhas do RabbitMQ diferentes', async () => {
    await runInit(['senha-a', '--yes']);
    await runInit(['senha-b', '--yes']);

    const passwordOf = (name) => {
      const env = readFileSync(path.join(baseDir, name, '.env'), 'utf8');
      return env.match(/^RABBITMQ_PASSWORD=(.+)$/m)[1];
    };

    const passwordA = passwordOf('senha-a');
    const passwordB = passwordOf('senha-b');

    expect(passwordA).not.toBe(passwordB);
    expect(passwordA.length).toBeGreaterThanOrEqual(8);
  }, 30000);

  test('duas execuções geram senhas do PostgreSQL diferentes', async () => {
    await runInit(['senha-pg-a', '--yes']);
    await runInit(['senha-pg-b', '--yes']);

    const passwordOf = (name) => {
      const env = readFileSync(path.join(baseDir, name, '.env'), 'utf8');
      return env.match(/^POSTGRES_PASSWORD=(.+)$/m)[1];
    };

    const passwordA = passwordOf('senha-pg-a');
    const passwordB = passwordOf('senha-pg-b');

    expect(passwordA).not.toBe(passwordB);
    expect(passwordA.length).toBeGreaterThanOrEqual(8);
  }, 30000);
});
