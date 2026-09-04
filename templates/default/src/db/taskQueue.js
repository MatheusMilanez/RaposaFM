import { getPool } from '../shared/db.js';

/**
 * Motor de idempotência e persistência de tarefas (M9) sobre a tabela
 * `tasks` (migração 0001) — enfileiramento, consumo concorrente e ciclo
 * de vida ficam todos aqui, um método por vez conforme as issues do M9
 * avançam.
 */

/**
 * Enfileira uma nova tarefa. Se `idempotencyKey` for informada e já
 * existir uma tarefa com essa chave, nenhuma linha nova é criada — a
 * tarefa já existente é retornada, com o status atual dela, em vez de
 * lançar erro.
 *
 * A deduplicação é garantida pelo índice único parcial em
 * idempotency_key (ver migração 0001): o INSERT com ON CONFLICT DO
 * NOTHING resolve o conflito de forma atômica dentro do próprio banco.
 * Duas chamadas concorrentes com a mesma chave nunca criam duas linhas
 * — uma delas "perde a corrida" e cai no SELECT de fallback abaixo, que
 * só é alcançado depois que a transação vencedora já commitou (é assim
 * que o Postgres resolve ON CONFLICT: espera a transação concorrente
 * terminar antes de decidir se houve conflito).
 *
 * Chamadas sem idempotencyKey nunca conflitam (NULL não é igual a NULL
 * em uma constraint única) e sempre criam uma tarefa nova.
 */
export async function enqueue({ queueName, payload, idempotencyKey = null, maxAttempts = 5 }) {
  const pool = getPool();

  const inserted = await pool.query(
    `INSERT INTO tasks (queue_name, payload, idempotency_key, max_attempts)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [queueName, JSON.stringify(payload), idempotencyKey, maxAttempts]
  );

  if (inserted.rows.length > 0) {
    return inserted.rows[0];
  }

  const existing = await pool.query('SELECT * FROM tasks WHERE idempotency_key = $1', [
    idempotencyKey,
  ]);
  return existing.rows[0];
}
