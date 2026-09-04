import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Teste end-to-end da migração 0001 contra um PostgreSQL real
 * (Testcontainers): roda o runner de produção (src/db/migrate.js) de
 * ponta a ponta, tanto pra cima quanto pra baixo — nada aqui reimplementa
 * a migração, só verifica o estado do banco depois de cada passo.
 */

let container;
let client;
let runMigrations;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();

  ({ runMigrations } = await import('../../src/db/migrate.js'));

  client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();
}, 60000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

async function enumValues() {
  const { rows } = await client.query(
    `SELECT e.enumlabel
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'task_status'
      ORDER BY e.enumsortorder`
  );
  return rows.map((r) => r.enumlabel);
}

async function columnsOf(table) {
  const { rows } = await client.query(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = $1`,
    [table]
  );
  return Object.fromEntries(rows.map((r) => [r.column_name, r]));
}

async function indexesOf(table) {
  const { rows } = await client.query('SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1', [
    table,
  ]);
  return Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
}

async function tableExists(table) {
  const { rows } = await client.query(
    'SELECT 1 FROM information_schema.tables WHERE table_name = $1',
    [table]
  );
  return rows.length > 0;
}

describe('migração 0001_create_tasks_table contra PostgreSQL real', () => {
  test('up cria o enum task_status com os 5 estados esperados', async () => {
    await runMigrations('up');

    expect(await enumValues()).toEqual([
      'pendente',
      'em_processamento',
      'concluido',
      'falhado',
      'morto',
    ]);
  });

  test('up cria a tabela tasks com as colunas essenciais', async () => {
    const columns = await columnsOf('tasks');

    expect(Object.keys(columns).sort()).toEqual(
      [
        'id',
        'queue_name',
        'payload',
        'status',
        'attempts',
        'max_attempts',
        'idempotency_key',
        'result',
        'error_message',
        'created_at',
        'updated_at',
      ].sort()
    );
    expect(columns.id.column_default).toMatch(/gen_random_uuid/);
    expect(columns.status.column_default).toMatch(/'pendente'/);
    expect(columns.queue_name.is_nullable).toBe('NO');
    expect(columns.payload.is_nullable).toBe('NO');
    expect(columns.idempotency_key.is_nullable).toBe('YES');
  });

  test('up cria o índice parcial de tarefas pendentes por fila e o índice da chave de idempotência', async () => {
    const indexes = await indexesOf('tasks');

    expect(indexes.idx_tasks_pending_by_queue).toMatch(/WHERE \(status = 'pendente'/);
    expect(indexes.idx_tasks_idempotency_key).toMatch(/UNIQUE INDEX/);
    expect(indexes.idx_tasks_idempotency_key).toMatch(/idempotency_key IS NOT NULL/);
  });

  test('rodar up de novo não falha e não duplica o registro da migração', async () => {
    await runMigrations('up');

    const { rows } = await client.query('SELECT id FROM schema_migrations');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('0001_create_tasks_table');
  });

  test('down remove a tabela e o tipo, revertendo a migração', async () => {
    await runMigrations('down');

    expect(await tableExists('tasks')).toBe(false);
    expect(await enumValues()).toEqual([]);

    const { rows } = await client.query('SELECT id FROM schema_migrations');
    expect(rows).toHaveLength(0);
  });

  test('up reaplica a migração depois do down', async () => {
    await runMigrations('up');

    expect(await tableExists('tasks')).toBe(true);
    expect(await enumValues()).toHaveLength(5);
  });
});
