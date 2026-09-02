#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit } from '../cli/init.mjs';

const pkg = JSON.parse(
  readFileSync(
    path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'package.json'),
    'utf8'
  )
);

function printHelp() {
  console.log(`
raposafm — cria um despachante de webhooks self-hosted pronto pra rodar.

Uso:
  npx raposafm init [nome-do-projeto] [opções]

Opções:
  --yes, -y      pula as perguntas, usa os padrões (senha aleatória)
  --force        sobrescreve a pasta de destino se ela já existir
  --help, -h     mostra esta ajuda
  --version, -v  mostra a versão
`);
}

async function main() {
  const [, , command, ...rest] = process.argv;

  if (command === '--version' || command === '-v') {
    console.log(pkg.version);
    return;
  }
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === 'init') {
    await runInit(rest);
    return;
  }

  console.error(`Comando desconhecido: ${command}\n`);
  printHelp();
  process.exitCode = 1;
}

main();
