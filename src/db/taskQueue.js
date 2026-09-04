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

/**
 * Retira a tarefa pendente mais antiga de uma fila e a marca como
 * `em_processamento`, pronta para um worker processar. Retorna `null`
 * quando não há nenhuma pendente — nunca lança erro por fila vazia.
 *
 * Um único UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) é
 * a seleção inteira: a subquery trava a linha escolhida (a mais antiga,
 * por created_at) e pula qualquer outra já travada por um worker
 * concorrente, em vez de esperar o lock liberar. Como é uma única
 * instrução SQL, a seleção e a transição de status já são atômicas por
 * conta própria — dois workers chamando isso ao mesmo tempo na mesma
 * fila nunca conseguem travar a mesma linha.
 */
export async function dequeue({ queueName }) {
  const pool = getPool();

  const { rows } = await pool.query(
    `UPDATE tasks
        SET status = 'em_processamento',
            attempts = attempts + 1,
            updated_at = now()
      WHERE id = (
        SELECT id
          FROM tasks
         WHERE queue_name = $1
           AND status = 'pendente'
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [queueName]
  );

  return rows[0] ?? null;
}
