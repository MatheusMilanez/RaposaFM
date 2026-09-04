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

// Idem para o motor de tarefas do PostgreSQL (M9): a rota chama enqueue()
// antes de publicar, então mockamos aqui também — nenhum Postgres real
// entra em cena. Por padrão sempre "cria" uma tarefa nova; os testes de
// idempotência sobrescrevem isso com created: false.
const enqueueMock = jest.fn();

jest.unstable_mockModule('../../src/db/taskQueue.js', () => ({
  enqueue: enqueueMock,
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
  enqueueMock.mockReset().mockResolvedValue({ id: 'task-id-padrao', created: true });
  assertPublicUrlMock.mockReset().mockResolvedValue(undefined);
  app = buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/v1/webhooks', () => {
  test('payload válido registra a tarefa, publica exatamente uma vez e responde 202 com o messageId da tarefa', async () => {
    enqueueMock.mockResolvedValueOnce({ id: 'task-id-123', created: true });
    publishWebhookMock.mockResolvedValueOnce(undefined);

    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .send({ url: 'https://exemplo.com/hook', payload: { evento: 'x' } });

    expect(res.status).toBe(202);
    expect(res.body.messageId).toBe('task-id-123');
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: null }));
    expect(publishWebhookMock).toHaveBeenCalledTimes(1);
    expect(publishWebhookMock).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'task-id-123' })
    );
  });

  test('sem url responde 400, não registra tarefa nem publica', async () => {
    const res = await request(app.server).post('/api/v1/webhooks').send({ payload: {} });
    expect(res.status).toBe(400);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(publishWebhookMock).not.toHaveBeenCalled();
  });

  test('sem payload responde 400, não registra tarefa nem publica', async () => {
    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .send({ url: 'https://exemplo.com' });
    expect(res.status).toBe(400);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(publishWebhookMock).not.toHaveBeenCalled();
  });

  test('url reprovada pelo guard de SSRF responde 400, não registra tarefa nem publica', async () => {
    assertPublicUrlMock.mockRejectedValueOnce(
      new FakeSsrfError('IP "169.254.169.254" pertence a uma faixa privada ou reservada')
    );

    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .send({ url: 'http://169.254.169.254/latest/meta-data', payload: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/faixa privada/);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(publishWebhookMock).not.toHaveBeenCalled();
  });

  test('campo desconhecido no corpo responde 400 (não descarta silenciosamente)', async () => {
    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .send({ url: 'https://exemplo.com', payload: {}, campoQueNaoExiste: true });
    expect(res.status).toBe(400);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(publishWebhookMock).not.toHaveBeenCalled();
  });

  test('corpo acima de 1MB é rejeitado com 413, antes de tentar registrar ou publicar', async () => {
    const payloadGigante = 'x'.repeat(2 * 1024 * 1024); // 2MB
    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .send({ url: 'https://exemplo.com', payload: { dado: payloadGigante } });
    expect(res.status).toBe(413);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(publishWebhookMock).not.toHaveBeenCalled();
  });

  test('banco de dados indisponível responde 503, nunca 202, e não publica', async () => {
    enqueueMock.mockRejectedValueOnce(new Error('sem conexão ativa com o PostgreSQL'));

    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .send({ url: 'https://exemplo.com', payload: {} });

    expect(res.status).toBe(503);
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

  test('Idempotency-Key repetida não publica de novo e responde com o messageId da tarefa original', async () => {
    enqueueMock.mockResolvedValueOnce({ id: 'task-id-existente', created: false });

    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .set('Idempotency-Key', 'chave-repetida')
      .send({ url: 'https://exemplo.com/hook', payload: { evento: 'x' } });

    expect(res.status).toBe(202);
    expect(res.body.messageId).toBe('task-id-existente');
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'chave-repetida' })
    );
    expect(publishWebhookMock).not.toHaveBeenCalled();
  });

  test('Idempotency-Key inédita registra, publica normalmente e propaga a chave pro enqueue()', async () => {
    enqueueMock.mockResolvedValueOnce({ id: 'task-id-nova', created: true });

    const res = await request(app.server)
      .post('/api/v1/webhooks')
      .set('Idempotency-Key', 'chave-nova')
      .send({ url: 'https://exemplo.com/hook', payload: { evento: 'x' } });

    expect(res.status).toBe(202);
    expect(res.body.messageId).toBe('task-id-nova');
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'chave-nova' })
    );
    expect(publishWebhookMock).toHaveBeenCalledTimes(1);
  });
});
