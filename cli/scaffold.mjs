import { cpSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const templateDir = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'templates',
  'default'
);

/**
 * Copia templates/default pra targetDir e resolve os placeholders.
 *
 * Alguns arquivos do template têm nome "disfarçado" (sem o ponto/extensão
 * final) — gitignore em vez de .gitignore, package.json.template em vez
 * de package.json. É um truque comum em CLIs de scaffolding: evita que
 * ferramentas do PRÓPRIO pacote publicado (git, npm) tratem esses
 * arquivos como se fossem delas antes da hora — o scaffold() é quem
 * corrige o nome, só no destino final.
 */
export function scaffold(targetDir, answers) {
  cpSync(templateDir, targetDir, { recursive: true });

  renameSync(path.join(targetDir, 'gitignore'), path.join(targetDir, '.gitignore'));
  renameSync(path.join(targetDir, 'dockerignore'), path.join(targetDir, '.dockerignore'));

  writeTemplated(
    path.join(targetDir, 'package.json.template'),
    path.join(targetDir, 'package.json'),
    answers
  );
  writeTemplated(
    path.join(targetDir, 'readme.md.template'),
    path.join(targetDir, 'readme.md'),
    answers
  );

  writeFileSync(path.join(targetDir, '.env'), buildEnv(targetDir, answers));
}

function writeTemplated(src, dest, answers) {
  const content = readFileSync(src, 'utf8').replaceAll('__PROJECT_NAME__', answers.projectName);
  writeFileSync(dest, content);
  rmSync(src);
}

function buildEnv(targetDir, answers) {
  const example = readFileSync(path.join(targetDir, '.env.example'), 'utf8');
  return example
    .replace(/^RABBITMQ_USER=.*/m, `RABBITMQ_USER=${answers.rabbitUser}`)
    .replace(/^RABBITMQ_PASSWORD=.*/m, `RABBITMQ_PASSWORD=${answers.rabbitPassword}`)
    .replace(
      /^RABBITMQ_URL=.*/m,
      `RABBITMQ_URL=amqp://${answers.rabbitUser}:${answers.rabbitPassword}@localhost:5672`
    )
    .replace(/^API_PORT=.*/m, `API_PORT=${answers.apiPort}`);
}
