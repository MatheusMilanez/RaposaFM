import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

const RETRYABLE_STATUS = new Set([408, 429]);

function isRetryableStatus(status) {
  return status >= 500 || RETRYABLE_STATUS.has(status);
}

async function readBodySnippet(response) {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return null;
  }
}

/**
 * Despacha um webhook para o destino final.
 *
 * Classificação do resultado (usada pela M4 para decidir retry vs. DLQ):
 * - 2xx -> sucesso
 * - 5xx, 408, 429, timeout, erro de rede -> falha transitória (retryable)
 * - 4xx (exceto 408/429) -> falha permanente (não retryable)
 */
export async function dispatch(message) {
  const { url, payload, headers, messageId, attempt } = message;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.worker.httpTimeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (response.ok) {
      logger.info('worker: entrega bem-sucedida', {
        messageId,
        tentativa: attempt,
        status: response.status,
        latencyMs,
      });
      await readBodySnippet(response);
      return { outcome: 'success', status: response.status, latencyMs };
    }

    const bodySnippet = await readBodySnippet(response);
    const retryable = isRetryableStatus(response.status);
    logger.warn('worker: destino respondeu com erro', {
      messageId,
      tentativa: attempt,
      status: response.status,
      latencyMs,
      retryable,
    });
    return {
      outcome: 'failure',
      retryable,
      status: response.status,
      latencyMs,
      error: `HTTP ${response.status}`,
      bodySnippet,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const isTimeout = err.name === 'AbortError';
    const errorMessage = isTimeout ? `timeout após ${config.worker.httpTimeoutMs}ms` : err.message;
    logger.warn('worker: falha de rede ao despachar', {
      messageId,
      tentativa: attempt,
      latencyMs,
      error: errorMessage,
    });
    // Timeout e erro de rede (conexão recusada, DNS, etc.) são sempre
    // transitórios: não há status HTTP para classificar como permanente.
    return { outcome: 'failure', retryable: true, status: null, latencyMs, error: errorMessage };
  } finally {
    clearTimeout(timeout);
  }
}
