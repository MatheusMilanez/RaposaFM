import { fileURLToPath } from 'node:url';
import { getPool } from '../shared/db.js';

/**
 * Remove tarefas antigas da tabela `tasks`, independente do status.
 *
 * Existe pra fechar um buraco que o motor de idempotência (M9) não
 * cobre sozinho: se enqueue() grava a linha mas a publicação no
 * RabbitMQ falha logo em seguida (broker fora do ar naquele instante),
 * a tarefa fica `pendente` para sempre — nenhum worker jamais vai vê-la,
 * porque a mensagem correspondente nunca chegou a existir na fila.
 * `completeTask`/`markTaskDead` (chamados pelo worker a cada entrega
 * real) fecham o ciclo das tarefas que chegam a ser processadas; isso
 * aqui varre as poucas que nunca chegam.
 *
 * Não tenta diferenciar "pendente por estar em retry" de "pendente
 * porque nunca foi publicada": o maior backoff configurado (README:
 * 15min, 5 tentativas) fica muito abaixo de `olderThanMs`, que por
 * padrão é medido em dias — não corre risco de apagar uma tarefa que
 * ainda vai ser tentada de novo.
 *
 * Roda por fora do processo da API/worker, via `npm run cleanup` (cron
 * do host, CronJob do k8s, etc.) — não existe agendador embutido nesse
 * projeto, e não é isso que esse script tenta ser.
 */
export async function deleteStaleTasks({ olderThanMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM tasks WHERE updated_at < now() - ($1 * interval '1 millisecond')`,
    [olderThanMs]
  );
  return rowCount;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = process.argv[2];
  const options = arg !== undefined ? { olderThanMs: Number(arg) } : {};

  deleteStaleTasks(options)
    .then((count) => {
      console.log(`tarefas removidas: ${count}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
