import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { logger } from '../../src/shared/logger.js';

// test/setup.js fixa LOG_LEVEL=error para o processo de teste inteiro, e
// src/shared/config.js é um singleton cacheado — não dá pra reimportar
// o logger sob outro nível sem reavaliar a config junto. Testamos contra
// o nível real do ambiente de teste em vez de forçar trocas artificiais.
describe('logger (LOG_LEVEL=error, valor do ambiente de teste)', () => {
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('debug, info e warn não imprimem abaixo do nível configurado', () => {
    logger.debug('não deveria aparecer');
    logger.info('não deveria aparecer');
    logger.warn('não deveria aparecer');
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('error vai para console.error, não console.log, como JSON estruturado', () => {
    logger.error('falhou', { motivo: 'teste' });
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(errorSpy.mock.calls[0][0]);
    expect(parsed).toMatchObject({ level: 'error', message: 'falhou', motivo: 'teste' });
    expect(parsed.time).toBeDefined();
  });
});
