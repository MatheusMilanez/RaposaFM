import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { dispatch } from '../../src/worker/dispatcher.js';

// Servidor HTTP efêmero local — dispatch() não sabe nem precisa saber que
// existe um RabbitMQ; ele só faz POST numa URL. Isso testa a classificação
// de resposta de ponta a ponta sem precisar de broker nenhum.
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
});
