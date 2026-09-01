/**
 * Configuração centralizada da aplicação.
 *
 * Lê as variáveis de ambiente, aplica valores padrão para as opcionais
 * e falha rápido (fail fast) quando falta uma variável obrigatória.
 * Tanto a API quanto o worker importam este módulo — nenhum dos dois
 * deve ler `process.env` diretamente fora daqui.
 */

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Configuração inválida: a variável de ambiente "${name}" é obrigatória e não foi definida. ` +
        'Confira o arquivo .env (veja .env.example para o modelo).'
    );
  }
  return value;
}

function optionalInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Configuração inválida: "${name}" deve ser um número inteiro, recebido "${raw}".`
    );
  }
  return parsed;
}

export const config = Object.freeze({
  rabbitmqUrl: required('RABBITMQ_URL'),
  api: Object.freeze({
    port: optionalInt('API_PORT', 3000),
  }),
  worker: Object.freeze({
    prefetch: optionalInt('WORKER_PREFETCH', 10),
    maxRetries: optionalInt('MAX_RETRIES', 5),
    httpTimeoutMs: optionalInt('HTTP_TIMEOUT_MS', 5000),
  }),
  logLevel: process.env.LOG_LEVEL || 'info',
});
