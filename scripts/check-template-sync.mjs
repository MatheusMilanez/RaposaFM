#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Confere se templates/default/src está idêntico a src/ — a parte que o
 * CLI (M8) copia pra máquina de quem roda `npx raposafm init`. Sem essa
 * checagem, uma mudança em src/ (uma correção de bug, por exemplo) fica
 * esquecida no template, e todo projeto novo sai com código defasado.
 *
 * Roda em CI (ou na mão: node scripts/check-template-sync.mjs) e sai com
 * código != 0 se encontrar qualquer divergência.
 */

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const realSrc = path.join(projectRoot, 'src');
const templateSrc = path.join(projectRoot, 'templates', 'default', 'src');

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full, base));
    } else {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

const realFiles = new Set(listFiles(realSrc));
const templateFiles = new Set(listFiles(templateSrc));

const problems = [];

for (const file of realFiles) {
  if (!templateFiles.has(file)) {
    problems.push(`faltando no template: src/${file}`);
    continue;
  }
  const a = readFileSync(path.join(realSrc, file), 'utf8');
  const b = readFileSync(path.join(templateSrc, file), 'utf8');
  if (a !== b) {
    problems.push(`conteúdo diferente: src/${file}`);
  }
}

for (const file of templateFiles) {
  if (!realFiles.has(file)) {
    problems.push(`sobrando no template, não existe em src/: ${file}`);
  }
}

if (problems.length > 0) {
  console.error('templates/default/src está fora de sincronia com src/:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nAtualize templates/default/src (copie de src/ de novo) antes de publicar.');
  process.exit(1);
}

console.log('templates/default/src está idêntico a src/.');
