import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Teste end-to-end do motor de tarefas (src/db/taskQueue.js) contra um
 * PostgreSQL real (Testcontainers), com o schema aplicado pelo runner
 * de produção (src/db/migrate.js) — nada aqui é mockado.
 */

let container;
let closePool;
let enqueue;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  // shared/config.js exige RABBITMQ_URL mesmo neste teste, que não usa
  // AMQP — é o mesmo módulo de config compartilhado por toda a app.
  process.env.RABBITMQ_URL ??= 'amqp://test:test@localhost:5672/';

  const { runMigrations } = await import('../../src/db/migrate.js');
  await runMigrations('up');

  ({ enqueue } = await import('../../src/db/taskQueue.js'));
  ({ closePool } = await import('../../src/shared/db.js'));
}, 60000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

describe('enqueue (#45)', () => {
  test('cria uma tarefa pendente sem chave de idempotência', async () => {
    const task = await enqueue({ queueName: 'fila-a', payload: { evento: 'sem-chave' } });

    expect(task.id).toBeDefined();
    expect(task.queue_name).toBe('fila-a');
    expect(task.payload).toEqual({ evento: 'sem-chave' });
    expect(task.status).toBe('pendente');
    expect(task.idempotency_key).toBeNull();
  });

  test('duas chamadas sem chave sempre criam tarefas diferentes', async () => {
    const a = await enqueue({ queueName: 'fila-a', payload: { n: 1 } });
    const b = await enqueue({ queueName: 'fila-a', payload: { n: 1 } });

    expect(a.id).not.toBe(b.id);
  });

  test('cria uma tarefa nova quando a chave de idempotência é inédita', async () => {
    const key = randomUUID();
    const task = await enqueue({
      queueName: 'fila-b',
      payload: { evento: 'chave-nova' },
      idempotencyKey: key,
    });

    expect(task.idempotency_key).toBe(key);
  });

  test('reenviar a mesma chave de idempotência retorna a tarefa original, sem duplicar', async () => {
    const key = randomUUID();

    const first = await enqueue({
      queueName: 'fila-c',
      payload: { tentativa: 1 },
      idempotencyKey: key,
    });
    const second = await enqueue({
      queueName: 'fila-c',
      payload: { tentativa: 2 }, // payload diferente — não importa, a original prevalece
      idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);
    expect(second.payload).toEqual({ tentativa: 1 });
    expect(second.status).toBe(first.status);
  });

  test('chamadas concorrentes com a mesma chave resolvem para uma única tarefa', async () => {
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        enqueue({ queueName: 'fila-d', payload: { concorrente: true }, idempotencyKey: key })
      )
    );

    const uniqueIds = new Set(results.map((task) => task.id));
    expect(uniqueIds.size).toBe(1);
  });
});
