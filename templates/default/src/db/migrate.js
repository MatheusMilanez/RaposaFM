import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Runner de migrações do PostgreSQL, sem depender de nenhuma ferramenta
 * externa: cada migração é um par de arquivos <id>.up.sql / <id>.down.sql
 * em migrations/, aplicados em ordem pelo prefixo numérico do nome. O
 * progresso fica registrado na tabela schema_migrations, criada
 * automaticamente na primeira execução.
 *
 * `down` reverte só a última migração aplicada — chame de novo pra
 * voltar mais um passo, como a maioria das ferramentas de migração faz.
 *
 * Uso: node src/db/migrate.js up | down
 */

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Configuração inválida: a variável de ambiente "${name}" é obrigatória e não foi definida.`
    );
  }
  return value;
}

function listMigrationIds() {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.up.sql'))
    .map((file) => file.replace(/\.up\.sql$/, ''))
    .sort();
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrationIds(client) {
  const { rows } = await client.query('SELECT id FROM schema_migrations ORDER BY id');
  return rows.map((row) => row.id);
}

async function runInTransaction(client, id, sql, onSuccess) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await onSuccess();
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`falha ao processar a migração "${id}": ${err.message}`, { cause: err });
  }
}

async function up(client) {
  await ensureMigrationsTable(client);
  const applied = new Set(await appliedMigrationIds(client));
  const pending = listMigrationIds().filter((id) => !applied.has(id));

  if (pending.length === 0) {
    console.log('nenhuma migração pendente.');
    return;
  }

  for (const id of pending) {
    const sql = readFileSync(path.join(migrationsDir, `${id}.up.sql`), 'utf8');
    await runInTransaction(client, id, sql, () =>
      client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id])
    );
    console.log(`migração aplicada: ${id}`);
  }
}

async function down(client) {
  await ensureMigrationsTable(client);
  const applied = await appliedMigrationIds(client);
  const last = applied[applied.length - 1];

  if (!last) {
    console.log('nenhuma migração aplicada para reverter.');
    return;
  }

  const sql = readFileSync(path.join(migrationsDir, `${last}.down.sql`), 'utf8');
  await runInTransaction(client, last, sql, () =>
    client.query('DELETE FROM schema_migrations WHERE id = $1', [last])
  );
  console.log(`migração revertida: ${last}`);
}

export async function runMigrations(direction) {
  if (direction !== 'up' && direction !== 'down') {
    throw new Error(`direção desconhecida: "${direction}" (use "up" ou "down")`);
  }

  const client = new pg.Client({ connectionString: requiredEnv('DATABASE_URL') });
  await client.connect();
  try {
    if (direction === 'up') await up(client);
    else await down(client);
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runMigrations(process.argv[2]).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
