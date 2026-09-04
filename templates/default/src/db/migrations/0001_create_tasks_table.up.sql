CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE task_status AS ENUM (
  'pendente',
  'em_processamento',
  'concluido',
  'falhado',
  'morto'
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name TEXT NOT NULL,
  payload JSONB NOT NULL,
  status task_status NOT NULL DEFAULT 'pendente',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  idempotency_key TEXT,
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Busca rápida da tarefa pendente mais antiga de uma fila (consumo FIFO
-- pelos workers) sem varrer linhas em outros status.
CREATE INDEX idx_tasks_pending_by_queue
  ON tasks (queue_name, created_at)
  WHERE status = 'pendente';

-- Garante a chave de idempotência única quando informada. Parcial (só
-- linhas não-nulas) porque a maioria das tarefas não usa idempotência e
-- não há motivo pra indexar isso.
CREATE UNIQUE INDEX idx_tasks_idempotency_key
  ON tasks (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
