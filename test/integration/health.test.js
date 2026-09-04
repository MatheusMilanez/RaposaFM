import { describe, test, expect, jest, beforeEach, afterEach, beforeAll } from '@jest/globals';
import request from 'supertest';

// src/api/server.js e src/api/publisher.js também importam de amqp.js
// (startAmqp, closeAmqp, getChannel) — o mock precisa cobrir tudo que é
// importado no grafo, não só o que este teste usa.
const isAmqpConnectedMock = jest.fn();

jest.unstable_mockModule('../../src/shared/amqp.js', () => ({
  isAmqpConnected: isAmqpConnectedMock,
  getChannel: jest.fn(),
  startAmqp: jest.fn(),
  closeAmqp: jest.fn(),
  publishConfirmed: jest.fn(),
}));

// src/api/server.js também importa closePool de db.js — mockado aqui
// pelo mesmo motivo, nenhum Postgres real entra em cena neste teste.
const pingDbMock = jest.fn();

jest.unstable_mockModule('../../src/shared/db.js', () => ({
  pingDb: pingDbMock,
  getPool: jest.fn(),
  closePool: jest.fn(),
}));

let buildServer;
let app;

beforeAll(async () => {
  ({ buildServer } = await import('../../src/api/server.js'));
});

beforeEach(async () => {
  app = buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('GET /health', () => {
  test('broker e banco conectados responde 200', async () => {
    isAmqpConnectedMock.mockReturnValue(true);
    pingDbMock.mockResolvedValue(true);

    const res = await request(app.server).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      rabbitmq: 'connected',
      database: 'connected',
    });
  });

  test('broker desconectado responde 503, mesmo com o banco ok', async () => {
    isAmqpConnectedMock.mockReturnValue(false);
    pingDbMock.mockResolvedValue(true);

    const res = await request(app.server).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'unavailable', rabbitmq: 'disconnected' });
  });

  test('banco desconectado responde 503, mesmo com o broker ok', async () => {
    isAmqpConnectedMock.mockReturnValue(true);
    pingDbMock.mockResolvedValue(false);

    const res = await request(app.server).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'unavailable', database: 'disconnected' });
  });
});
