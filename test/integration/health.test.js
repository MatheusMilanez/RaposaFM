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
  test('broker conectado responde 200', async () => {
    isAmqpConnectedMock.mockReturnValue(true);
    const res = await request(app.server).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', rabbitmq: 'connected' });
  });

  test('broker desconectado responde 503', async () => {
    isAmqpConnectedMock.mockReturnValue(false);
    const res = await request(app.server).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'unavailable', rabbitmq: 'disconnected' });
  });
});
