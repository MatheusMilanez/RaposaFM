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
let getPool;
let enqueue;
let dequeue;
let completeTask;
let failTask;
let deleteStaleTasks;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  // shared/config.js exige RABBITMQ_URL mesmo neste teste, que não usa
  // AMQP — é o mesmo módulo de config compartilhado por toda a app.
  process.env.RABBITMQ_URL ??= 'amqp://test:test@localhost:5672/';

  const { runMigrations } = await import('../../src/db/migrate.js');
  await runMigrations('up');

  ({ enqueue, dequeue, completeTask, failTask } = await import('../../src/db/taskQueue.js'));
  ({ deleteStaleTasks } = await import('../../src/db/cleanup.js'));
  ({ getPool, closePool } = await import('../../src/shared/db.js'));
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
    expect(task.created).toBe(true);
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
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
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

describe('dequeue (#46)', () => {
  test('retorna null quando não há tarefa pendente na fila', async () => {
    const task = await dequeue({ queueName: 'fila-vazia' });

    expect(task).toBeNull();
  });

  test('captura a tarefa pendente mais antiga da fila (FIFO) e transiciona o status', async () => {
    const first = await enqueue({ queueName: 'fila-e', payload: { ordem: 1 } });
    const second = await enqueue({ queueName: 'fila-e', payload: { ordem: 2 } });

    const captured = await dequeue({ queueName: 'fila-e' });

    expect(captured.id).toBe(first.id);
    expect(captured.status).toBe('em_processamento');
    expect(captured.attempts).toBe(1);
    expect(new Date(captured.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(captured.created_at).getTime()
    );

    const captured2 = await dequeue({ queueName: 'fila-e' });
    expect(captured2.id).toBe(second.id);
  });

  test('não retorna tarefa de outra fila nem uma já capturada', async () => {
    await enqueue({ queueName: 'fila-f', payload: { n: 1 } });

    const outraFila = await dequeue({ queueName: 'fila-g' });
    expect(outraFila).toBeNull();

    const primeira = await dequeue({ queueName: 'fila-f' });
    expect(primeira).not.toBeNull();

    const segunda = await dequeue({ queueName: 'fila-f' });
    expect(segunda).toBeNull(); // já foi capturada, não está mais pendente
  });

  test('chamadas concorrentes na mesma fila nunca capturam a mesma tarefa (SKIP LOCKED)', async () => {
    const N = 10;
    const tasks = [];
    for (let i = 0; i < N; i++) {
      tasks.push(await enqueue({ queueName: 'fila-h', payload: { i } }));
    }

    const results = await Promise.all(
      Array.from({ length: N }, () => dequeue({ queueName: 'fila-h' }))
    );

    expect(results.every((task) => task !== null)).toBe(true);
    const capturedIds = new Set(results.map((task) => task.id));
    expect(capturedIds.size).toBe(N);
    expect(capturedIds).toEqual(new Set(tasks.map((task) => task.id)));

    // fila esgotada: uma chamada a mais não encontra nada pendente nem duplicado
    expect(await dequeue({ queueName: 'fila-h' })).toBeNull();
  });
});

describe('completeTask / failTask (#47)', () => {
  test('completeTask grava o resultado e conclui a tarefa', async () => {
    const task = await enqueue({ queueName: 'fila-i', payload: { n: 1 } });
    const captured = await dequeue({ queueName: 'fila-i' });

    const done = await completeTask({ id: captured.id, result: { ok: true } });

    expect(done.status).toBe('concluido');
    expect(done.result).toEqual({ ok: true });
    expect(new Date(done.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(captured.updated_at).getTime()
    );
    expect(task.id).toBe(done.id);
  });

  test('failTask devolve a tarefa para pendente quando ainda há tentativas disponíveis', async () => {
    const task = await enqueue({ queueName: 'fila-j', payload: {}, maxAttempts: 3 });
    const captured = await dequeue({ queueName: 'fila-j' }); // attempts vira 1, max_attempts 3

    const failed = await failTask({ id: task.id, errorMessage: 'timeout' });

    expect(failed.status).toBe('pendente');
    expect(failed.error_message).toBe('timeout');
    expect(failed.attempts).toBe(1);
    expect(new Date(failed.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(captured.updated_at).getTime()
    );
  });

  test('failTask move a tarefa para morto quando o limite de tentativas se esgota', async () => {
    const task = await enqueue({ queueName: 'fila-k', payload: {}, maxAttempts: 1 });
    await dequeue({ queueName: 'fila-k' }); // attempts vira 1, igual ao max_attempts

    const failed = await failTask({ id: task.id, errorMessage: 'sempre falha' });

    expect(failed.status).toBe('morto');
    expect(failed.error_message).toBe('sempre falha');
  });

  test('tarefa que falha e depois é recapturada pode concluir com sucesso na tentativa seguinte', async () => {
    const task = await enqueue({ queueName: 'fila-l', payload: {}, maxAttempts: 3 });
    await dequeue({ queueName: 'fila-l' });
    await failTask({ id: task.id, errorMessage: 'falha transitória' });

    const recaptured = await dequeue({ queueName: 'fila-l' });
    expect(recaptured.id).toBe(task.id);
    expect(recaptured.attempts).toBe(2);

    const done = await completeTask({ id: task.id, result: { tentativa: 2 } });
    expect(done.status).toBe('concluido');
    expect(done.result).toEqual({ tentativa: 2 });
  });
});

describe('idempotência e disputa entre workers sob concorrência real (#48)', () => {
  test('N requisições de enfileiramento em paralelo com a mesma chave persistem uma única linha, e todas retornam o mesmo registro', async () => {
    const key = randomUUID();
    const N = 25;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        enqueue({ queueName: 'fila-idempotencia-48', payload: { i }, idempotencyKey: key })
      )
    );

    // exatamente uma chamada "ganhou a corrida" e criou a linha; todas
    // as outras enxergam a mesma tarefa (mesmo id, mesmo conteúdo).
    const [first, ...rest] = results;
    expect(results.filter((task) => task.created)).toHaveLength(1);
    for (const task of rest) {
      expect(task.id).toBe(first.id);
      expect(task.payload).toEqual(first.payload);
      expect(task.status).toBe(first.status);
    }

    const { rows } = await getPool().query(
      'SELECT count(*)::int AS count FROM tasks WHERE idempotency_key = $1',
      [key]
    );
    expect(rows[0].count).toBe(1);
  });

  test('mais workers concorrentes do que tarefas disponíveis: cada tarefa é entregue a exatamente um worker, nunca a dois', async () => {
    const TASKS = 8;
    const WORKERS = 20;

    const enqueued = [];
    for (let i = 0; i < TASKS; i++) {
      enqueued.push(await enqueue({ queueName: 'fila-disputa-48', payload: { i } }));
    }

    const results = await Promise.all(
      Array.from({ length: WORKERS }, () => dequeue({ queueName: 'fila-disputa-48' }))
    );

    const captured = results.filter((task) => task !== null);
    const misses = results.filter((task) => task === null);

    expect(captured).toHaveLength(TASKS);
    expect(misses).toHaveLength(WORKERS - TASKS);

    const capturedIds = captured.map((task) => task.id);
    expect(new Set(capturedIds).size).toBe(TASKS); // sem duplicatas entre os workers
    expect(new Set(capturedIds)).toEqual(new Set(enqueued.map((task) => task.id)));
  });
});

async function ageTask(id, ms) {
  await getPool().query(
    `UPDATE tasks SET updated_at = now() - ($2 * interval '1 millisecond') WHERE id = $1`,
    [id, ms]
  );
}

describe('deleteStaleTasks (limpeza de tarefas órfãs)', () => {
  test('remove tarefas mais velhas que o limite, preserva as recentes', async () => {
    const velha = await enqueue({ queueName: 'fila-limpeza', payload: { orfa: true } });
    const recente = await enqueue({ queueName: 'fila-limpeza', payload: { orfa: false } });
    await ageTask(velha.id, 8 * 24 * 60 * 60 * 1000); // 8 dias

    const removed = await deleteStaleTasks({ olderThanMs: 7 * 24 * 60 * 60 * 1000 });

    expect(removed).toBeGreaterThanOrEqual(1);
    const { rows: velhaRows } = await getPool().query('SELECT 1 FROM tasks WHERE id = $1', [
      velha.id,
    ]);
    expect(velhaRows).toHaveLength(0);
    const { rows: recenteRows } = await getPool().query('SELECT 1 FROM tasks WHERE id = $1', [
      recente.id,
    ]);
    expect(recenteRows).toHaveLength(1);
  });

  test('limite padrão não remove uma tarefa criada agora', async () => {
    const task = await enqueue({ queueName: 'fila-limpeza-padrao', payload: {} });

    await deleteStaleTasks();

    const { rows } = await getPool().query('SELECT 1 FROM tasks WHERE id = $1', [task.id]);
    expect(rows).toHaveLength(1);
  });
});
