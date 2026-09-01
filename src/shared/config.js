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

function optionalIntList(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = raw.split(',').map((part) => Number.parseInt(part.trim(), 10));
  if (parsed.length === 0 || parsed.some((n) => Number.isNaN(n) || n < 0)) {
    throw new Error(
      `Configuração inválida: "${name}" deve ser uma lista de inteiros não-negativos separados ` +
        `por vírgula (ex.: "60000,300000,900000"), recebido "${raw}".`
    );
  }
  return parsed;
}

function optionalBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

export const config = Object.freeze({
  rabbitmqUrl: required('RABBITMQ_URL'),
  api: Object.freeze({
    port: optionalInt('API_PORT', 3000),
  }),
  // Válvula de escape só para desenvolvimento local/testes: permite webhook
  // apontando pra localhost/IP privado. Nunca ligar isso em produção — é
  // exatamente a proteção contra SSRF que essa flag desliga.
  allowPrivateNetworkUrls: optionalBool('ALLOW_PRIVATE_NETWORK_URLS', false),
  worker: Object.freeze({
    prefetch: optionalInt('WORKER_PREFETCH', 10),
    maxRetries: optionalInt('MAX_RETRIES', 5),
    httpTimeoutMs: optionalInt('HTTP_TIMEOUT_MS', 5000),
    // Degraus do backoff exponencial, em ms. A tentativa N usa o degrau
    // min(N-1, tamanho-1) — depois do último degrau, repete o valor final
    // até MAX_RETRIES estourar. Padrão: 1min, 5min, 15min (README).
    backoffScheduleMs: optionalIntList('RETRY_BACKOFF_MS', [60_000, 300_000, 900_000]),
  }),
  logLevel: process.env.LOG_LEVEL || 'info',
});
