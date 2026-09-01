import { describe, test, expect, jest } from '@jest/globals';
import { decideOutcome, publishToDlq, publishToWait } from '../../src/worker/retryPolicy.js';
import { EXCHANGE, ROUTING_KEYS } from '../../src/shared/topology.js';

// test/setup.js define RETRY_BACKOFF_MS=1000,2000,4000 e MAX_RETRIES=5.

function fakeChannel() {
  return { publish: jest.fn().mockReturnValue(true) };
}

describe('decideOutcome', () => {
  test('falha não-retryable vai direto pra DLQ, mesmo na primeira tentativa', () => {
    const message = { attempt: 0 };
    const result = { retryable: false, status: 404, error: 'HTTP 404' };
    expect(decideOutcome(message, result)).toEqual({ action: 'dlq', reason: 'falha permanente' });
  });

  test('primeira falha retryable agenda retry no primeiro degrau do backoff', () => {
    const message = { attempt: 0 };
    const result = { retryable: true, status: 500, error: 'HTTP 500' };
    expect(decideOutcome(message, result)).toEqual({
      action: 'retry',
      nextAttempt: 1,
      delayMs: 1000,
    });
  });

  test('segunda falha usa o segundo degrau', () => {
    const message = { attempt: 1 };
    const result = { retryable: true, status: 500, error: 'HTTP 500' };
    expect(decideOutcome(message, result)).toEqual({
      action: 'retry',
      nextAttempt: 2,
      delayMs: 2000,
    });
  });

  test('tentativa além do tamanho da escada repete o último degrau (ainda dentro de MAX_RETRIES)', () => {
    // setup.js: MAX_RETRIES=5, backoff com 3 degraus — na 4ª tentativa já
    // não há degrau próprio, mas ainda não estourou o teto de retries.
    const message = { attempt: 3 };
    const result = { retryable: true, status: 503, error: 'HTTP 503' };
    expect(decideOutcome(message, result)).toEqual({
      action: 'retry',
      nextAttempt: 4,
      delayMs: 4000, // repete o último degrau configurado
    });
  });

  test('esgota as tentativas e vai pra DLQ quando atinge MAX_RETRIES', () => {
    const message = { attempt: 4 }; // próxima tentativa seria a 5ª = MAX_RETRIES
    const result = { retryable: true, status: 500, error: 'HTTP 500' };
    expect(decideOutcome(message, result)).toEqual({
      action: 'dlq',
      reason: 'tentativas esgotadas',
      nextAttempt: 5,
    });
  });
});

describe('publishToWait', () => {
  test('publica no exchange certo com o TTL da tentativa como expiration', () => {
    const ch = fakeChannel();
    const message = { messageId: 'm1', url: 'https://x', payload: {}, attempt: 0 };
    const result = { retryable: true, status: 500, error: 'HTTP 500' };

    publishToWait(ch, message, result, { nextAttempt: 1, delayMs: 1000 });

    expect(ch.publish).toHaveBeenCalledTimes(1);
    const [exchange, routingKey, buffer, options] = ch.publish.mock.calls[0];
    expect(exchange).toBe(EXCHANGE);
    expect(routingKey).toBe(ROUTING_KEYS.wait);
    expect(options.expiration).toBe('1000'); // amqplib espera string em ms
    expect(options.persistent).toBe(true);

    const published = JSON.parse(buffer.toString());
    expect(published.attempt).toBe(1);
    expect(published.lastStatus).toBe(500);
  });
});

describe('publishToDlq', () => {
  test('publica no exchange certo com o contexto do erro', () => {
    const ch = fakeChannel();
    const message = { messageId: 'm2', url: 'https://x', payload: {}, attempt: 2 };
    const result = { retryable: true, status: 500, error: 'HTTP 500' };

    publishToDlq(ch, message, result, { attempt: 3 });

    const [exchange, routingKey, buffer] = ch.publish.mock.calls[0];
    expect(exchange).toBe(EXCHANGE);
    expect(routingKey).toBe(ROUTING_KEYS.dlq);

    const published = JSON.parse(buffer.toString());
    expect(published.attempt).toBe(3);
    expect(published.lastError).toBe('HTTP 500');
    expect(published.lastAttemptAt).toBeDefined();
  });

  test('sem attempt explícito, preserva o attempt original da mensagem', () => {
    const ch = fakeChannel();
    const message = { messageId: 'm3', url: 'https://x', payload: {}, attempt: 0 };
    const result = { retryable: false, status: 404, error: 'HTTP 404' };

    publishToDlq(ch, message, result);

    const published = JSON.parse(ch.publish.mock.calls[0][2].toString());
    expect(published.attempt).toBe(0);
  });
});
