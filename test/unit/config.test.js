import { describe, test, expect, afterEach } from '@jest/globals';

// config.js é um singleton cacheado — para testar os caminhos de erro
// sob variáveis de ambiente diferentes, cada teste importa com uma
// query string única, forçando o Jest a avaliar uma cópia nova do
// módulo (config.js não depende de nada que já esteja cacheado de
// outro jeito, então isso funciona bem aqui — ver o comentário em
// test/unit/logger.test.js sobre por que essa técnica NÃO serve lá).
const originalEnv = {
  RABBITMQ_URL: process.env.RABBITMQ_URL,
  API_PORT: process.env.API_PORT,
  RETRY_BACKOFF_MS: process.env.RETRY_BACKOFF_MS,
};

function restoreEnv(key) {
  if (originalEnv[key] === undefined) delete process.env[key];
  else process.env[key] = originalEnv[key];
}

afterEach(() => {
  restoreEnv('RABBITMQ_URL');
  restoreEnv('API_PORT');
  restoreEnv('RETRY_BACKOFF_MS');
});

describe('config (validação fail-fast)', () => {
  test('lança erro claro quando RABBITMQ_URL não está definida', async () => {
    delete process.env.RABBITMQ_URL;
    await expect(import('../../src/shared/config.js?missing-url')).rejects.toThrow(
      /RABBITMQ_URL.*obrigatória/
    );
  });

  test('lança erro quando uma variável numérica opcional não é um inteiro', async () => {
    process.env.RABBITMQ_URL = 'amqp://x';
    process.env.API_PORT = 'não-é-numero';
    await expect(import('../../src/shared/config.js?bad-int')).rejects.toThrow(/API_PORT/);
  });

  test('lança erro quando RETRY_BACKOFF_MS tem um item inválido na lista', async () => {
    process.env.RABBITMQ_URL = 'amqp://x';
    process.env.RETRY_BACKOFF_MS = '1000,abc,3000';
    await expect(import('../../src/shared/config.js?bad-list')).rejects.toThrow(/RETRY_BACKOFF_MS/);
  });

  test('aceita configuração válida e aplica os padrões das opcionais', async () => {
    process.env.RABBITMQ_URL = 'amqp://x';
    delete process.env.API_PORT;
    delete process.env.RETRY_BACKOFF_MS;
    const { config } = await import('../../src/shared/config.js?valid');
    expect(config.rabbitmqUrl).toBe('amqp://x');
    expect(config.api.port).toBe(3000);
    expect(config.worker.backoffScheduleMs).toEqual([60_000, 300_000, 900_000]);
  });
});
