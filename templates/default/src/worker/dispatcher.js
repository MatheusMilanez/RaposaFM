import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { assertPublicUrl, SsrfError } from '../shared/ssrfGuard.js';

const RETRYABLE_STATUS = new Set([408, 429]);
const MAX_RESPONSE_BODY_BYTES = 2048;

function isRetryableStatus(status) {
  return status >= 500 || RETRYABLE_STATUS.has(status);
}

/** Lê no máximo MAX_RESPONSE_BODY_BYTES da resposta, sem baixar o corpo inteiro. */
async function readBodySnippet(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  try {
    const chunks = [];
    let received = 0;
    while (received < MAX_RESPONSE_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
    await reader.cancel().catch(() => {});
    return Buffer.concat(chunks.map((c) => Buffer.from(c)))
      .subarray(0, MAX_RESPONSE_BODY_BYTES)
      .toString('utf8');
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
 * - bloqueio de SSRF ou redirecionamento inesperado -> falha permanente
 *
 * Revalida a URL contra o guard de SSRF a cada tentativa (não só na
 * ingestão) e não segue redirecionamentos automaticamente: um destino
 * malicioso poderia devolver um 3xx apontando pra rede interna depois
 * de passar na validação inicial.
 */
export async function dispatch(message) {
  const { url, payload, headers, messageId, attempt } = message;

  try {
    await assertPublicUrl(url);
  } catch (err) {
    if (err instanceof SsrfError) {
      logger.warn('worker: despacho bloqueado pelo guard de SSRF', {
        messageId,
        tentativa: attempt,
        motivo: err.message,
      });
      return { outcome: 'failure', retryable: false, status: null, error: `SSRF: ${err.message}` };
    }
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.worker.httpTimeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'manual',
    });
    const latencyMs = Date.now() - startedAt;

    // redirect:'manual' faz o fetch devolver um response "opaco" em vez
    // de seguir o 3xx sozinho. Tratamos como falha permanente: o
    // destino devolveu algo que não deveria, e seguir cegamente é
    // exatamente a brecha de SSRF via redirecionamento.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      logger.warn('worker: destino tentou redirecionar, não seguido', {
        messageId,
        tentativa: attempt,
        status: response.status || null,
      });
      return {
        outcome: 'failure',
        retryable: false,
        status: response.status || null,
        error: 'redirecionamento não permitido',
      };
    }

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
