import { describe, test, expect, jest, beforeEach, afterEach, beforeAll } from '@jest/globals';
import request from 'supertest';

// O broker é mockado aqui: a rota importa publishWebhook de ../publisher.js,
// então interceptamos esse módulo antes de importar o server. Nenhum
// RabbitMQ real entra em cena nestes testes.
const publishWebhookMock = jest.fn();

jest.unstable_mockModule('../../src/api/publisher.js', () => ({
  publishWebhook: publishWebhookMock,
  isPublisherReady: () => true,
}));

// O guard de SSRF de verdade faz uma resolução DNS real — mockado aqui
// pra este arquivo não depender de rede. A lógica do guard em si tem
// suíte própria em test/unit/ssrfGuard.test.js.
const assertPublicUrlMock = jest.fn().mockResolvedValue(undefined);

class FakeSsrfError extends Error {}

jest.unstable_mockModule('../../src/shared/ssrfGuard.js', () => ({
  assertPublicUrl: assertPublicUrlMock,
  SsrfError: FakeSsrfError,
}));

let buildServer;
let app;

beforeAll(async () => {
  ({ buildServer } = await import('../../src/api/server.js'));
});

beforeEach(async () => {
  publishWebhookMock.mockReset();
  assertPublicUrlMock.mockReset().mockResolvedValue(undefined);
  app = buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/v1/webhooks', () => {
  test('payload válido publica exatamente uma vez e responde 202 com messageId', async () => {
    publishWebhookMock.mockResolvedValueOnce(undefined);

    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .send({ url: 'https://exemplo.com/hook', payload: { evento: 'x' } });

    expect(res.status).toBe(202);
    expect(res.body.messageId).toEqual(expect.any(String));
    expect(publishWebhookMock).toHaveBeenCalledTimes(1);
  });

  test('sem url responde 400 e não publica', async () => {
    const res = await request(app.server).post('/api/v1/webhooks').send({ payload: {} });
    expect(res.status).toBe(400);
    expect(publishWebhookMock).not.toHaveBeenCalled();
  });

  test('sem payload responde 400 e não publica', async () => {
    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .send({ url: 'https://exemplo.com' });
    expect(res.status).toBe(400);
    expect(publishWebhookMock).not.toHaveBeenCalled();
  });

  test('url reprovada pelo guard de SSRF responde 400 e não publica', async () => {
    assertPublicUrlMock.mockRejectedValueOnce(
      new FakeSsrfError('IP "169.254.169.254" pertence a uma faixa privada ou reservada')
    );

    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .send({ url: 'http://169.254.169.254/latest/meta-data', payload: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/faixa privada/);
    expect(publishWebhookMock).not.toHaveBeenCalled();
  });

  test('campo desconhecido no corpo responde 400 (não descarta silenciosamente)', async () => {
    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .send({ url: 'https://exemplo.com', payload: {}, campoQueNaoExiste: true });
    expect(res.status).toBe(400);
    expect(publishWebhookMock).not.toHaveBeenCalled();
  });

  test('corpo acima de 1MB é rejeitado com 413, antes de tentar publicar', async () => {
    const payloadGigante = 'x'.repeat(2 * 1024 * 1024); // 2MB
    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .send({ url: 'https://exemplo.com', payload: { dado: payloadGigante } });
    expect(res.status).toBe(413);
    expect(publishWebhookMock).not.toHaveBeenCalled();
  });

  test('broker indisponível responde 503, nunca 202', async () => {
    publishWebhookMock.mockRejectedValueOnce(new Error('sem conexão ativa com o RabbitMQ'));

    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .send({ url: 'https://exemplo.com', payload: {} });

    expect(res.status).toBe(503);
    expect(res.status).not.toBe(202);
  });
});
