import { describe, test, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import http from 'node:http';

// O servidor de teste roda em 127.0.0.1 (loopback) — o guard de SSRF de
// verdade bloquearia isso. Mockado aqui pra testar a lógica HTTP do
// dispatch() isoladamente; a lógica do guard em si tem suíte própria
// em test/unit/ssrfGuard.test.js, e o uso do guard dentro do dispatch()
// é verificado nos dois testes dedicados no fim deste arquivo.
const assertPublicUrlMock = jest.fn().mockResolvedValue(undefined);

class FakeSsrfError extends Error {}

jest.unstable_mockModule('../../src/shared/ssrfGuard.js', () => ({
  assertPublicUrl: assertPublicUrlMock,
  SsrfError: FakeSsrfError,
}));

const { dispatch } = await import('../../src/worker/dispatcher.js');

let server;
let baseUrl;
let receivedHeaders;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === '/erro500') {
      res.writeHead(500);
      res.end('falha interna');
    } else if (req.url === '/erro404') {
      res.writeHead(404);
      res.end('não encontrado');
    } else if (req.url === '/redireciona') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
    } else if (req.url === '/lento') {
      // Maior que o HTTP_TIMEOUT_MS=2000 do test/setup.js, pra garantir o
      // timeout do cliente — mas .unref() e cancelado se o cliente abortar
      // antes, pra não prender o processo de teste esperando esse timer.
      const timer = setTimeout(() => {
        res.writeHead(200);
        res.end('devagar');
      }, 2500).unref();
      req.on('aborted', () => clearTimeout(timer));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  assertPublicUrlMock.mockReset().mockResolvedValue(undefined);
});

describe('dispatch', () => {
  test('2xx é sucesso', async () => {
    const result = await dispatch({ url: `${baseUrl}/ok`, payload: {}, headers: {}, attempt: 0 });
    expect(result.outcome).toBe('success');
    expect(result.status).toBe(200);
  });

  test('5xx é falha retryable', async () => {
    const result = await dispatch({
      url: `${baseUrl}/erro500`,
      payload: {},
      headers: {},
      attempt: 0,
    });
    expect(result.outcome).toBe('failure');
    expect(result.retryable).toBe(true);
    expect(result.status).toBe(500);
  });

  test('404 é falha não-retryable', async () => {
    const result = await dispatch({
      url: `${baseUrl}/erro404`,
      payload: {},
      headers: {},
      attempt: 0,
    });
    expect(result.outcome).toBe('failure');
    expect(result.retryable).toBe(false);
    expect(result.status).toBe(404);
  });

  test('timeout é falha retryable, sem status HTTP', async () => {
    const result = await dispatch({
      url: `${baseUrl}/lento`,
      payload: {},
      headers: {},
      attempt: 0,
    });
    expect(result.outcome).toBe('failure');
    expect(result.retryable).toBe(true);
    expect(result.status).toBeNull();
    expect(result.error).toMatch(/timeout/);
  }, 10000);

  test('conexão recusada é falha retryable', async () => {
    // Porta 1 é reservada e nada deve estar escutando nela.
    const result = await dispatch({
      url: 'http://127.0.0.1:1/',
      payload: {},
      headers: {},
      attempt: 0,
    });
    expect(result.outcome).toBe('failure');
    expect(result.retryable).toBe(true);
    expect(result.status).toBeNull();
  });

  test('repassa os headers customizados da mensagem para o destino', async () => {
    await dispatch({
      url: `${baseUrl}/ok`,
      payload: { a: 1 },
      headers: { 'x-custom': 'abc123' },
      attempt: 0,
    });
    expect(receivedHeaders['x-custom']).toBe('abc123');
    expect(receivedHeaders['content-type']).toBe('application/json');
  });

  test('redirecionamento do destino não é seguido, vira falha não-retryable', async () => {
    const result = await dispatch({
      url: `${baseUrl}/redireciona`,
      payload: {},
      headers: {},
      attempt: 0,
    });
    expect(result.outcome).toBe('failure');
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/redirecionamento/);
  });

  test('URL bloqueada pelo guard de SSRF nunca chega a fazer a requisição HTTP', async () => {
    assertPublicUrlMock.mockRejectedValueOnce(new FakeSsrfError('IP privado'));

    const result = await dispatch({ url: `${baseUrl}/ok`, payload: {}, headers: {}, attempt: 0 });

    expect(result.outcome).toBe('failure');
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/SSRF/);
  });
});
