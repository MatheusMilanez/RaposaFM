import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// Só handleMessage é testada aqui — o resto de consumer.js (prefetch,
// consume, cancel) depende da semântica real do amqplib e é coberto
// pelo e2e (test/e2e/webhook-flow.test.js, issue #31).
const dispatchMock = jest.fn();
jest.unstable_mockModule('../../src/worker/dispatcher.js', () => ({ dispatch: dispatchMock }));

const { handleMessage } = await import('../../src/worker/consumer.js');

// publishConfirmed() (usado por publishToWait/publishToDlq) chama
// publish() com um callback como 5º argumento, disparado quando o
// broker confirma — o fake precisa invocá-lo pra promise resolver.
function fakeChannel() {
  return {
    ack: jest.fn(),
    nack: jest.fn(),
    publish: jest.fn((exchange, routingKey, buffer, options, cb) => {
      cb(null);
      return true;
    }),
  };
}

function fakeMsg(message) {
  return { content: Buffer.from(JSON.stringify(message)) };
}

describe('handleMessage', () => {
  beforeEach(() => dispatchMock.mockReset());

  test('sucesso: confirma a mensagem, não publica em lugar nenhum', async () => {
    dispatchMock.mockResolvedValue({ outcome: 'success', status: 200 });
    const ch = fakeChannel();
    const msg = fakeMsg({ messageId: 'm1', attempt: 0 });

    await handleMessage(ch, msg);

    expect(ch.ack).toHaveBeenCalledWith(msg);
    expect(ch.publish).not.toHaveBeenCalled();
  });

  test('falha retryable dentro do limite: publica na fila de espera com a próxima tentativa', async () => {
    dispatchMock.mockResolvedValue({
      outcome: 'failure',
      retryable: true,
      status: 500,
      error: 'HTTP 500',
    });
    const ch = fakeChannel();
    const msg = fakeMsg({ messageId: 'm2', attempt: 0 });

    await handleMessage(ch, msg);

    expect(ch.publish).toHaveBeenCalledTimes(1);
    const options = ch.publish.mock.calls[0][3];
    expect(options.expiration).toBeDefined();
    const published = JSON.parse(ch.publish.mock.calls[0][2].toString());
    expect(published.attempt).toBe(1);
    expect(ch.ack).toHaveBeenCalledWith(msg);
  });

  test('falha permanente: publica na DLQ preservando o attempt original', async () => {
    dispatchMock.mockResolvedValue({
      outcome: 'failure',
      retryable: false,
      status: 404,
      error: 'HTTP 404',
    });
    const ch = fakeChannel();
    const msg = fakeMsg({ messageId: 'm3', attempt: 0 });

    await handleMessage(ch, msg);

    const published = JSON.parse(ch.publish.mock.calls[0][2].toString());
    expect(published.attempt).toBe(0);
  });

  test('esgota MAX_RETRIES: DLQ recebe o attempt final correto (regressão de wiring consumer.js↔retryPolicy.js)', async () => {
    // test/setup.js: MAX_RETRIES=5. attempt:4 -> nextAttempt:5 -> esgota.
    // Bug real encontrado via e2e (Testcontainers): consumer.js passava o
    // objeto `decision` inteiro pra publishToDlq, que espera uma chave
    // `attempt`, mas decideOutcome devolve `nextAttempt` — o contador na
    // DLQ ficava sempre 1 a menos do real. Corrigido; este teste cobre
    // esse caminho específico sem precisar subir um broker.
    dispatchMock.mockResolvedValue({
      outcome: 'failure',
      retryable: true,
      status: 500,
      error: 'HTTP 500',
    });
    const ch = fakeChannel();
    const msg = fakeMsg({ messageId: 'm4', attempt: 4 });

    await handleMessage(ch, msg);

    const published = JSON.parse(ch.publish.mock.calls[0][2].toString());
    expect(published.attempt).toBe(5);
  });

  test('mensagem malformada é descartada sem chamar dispatch nem derrubar o worker', async () => {
    const ch = fakeChannel();
    const msg = { content: Buffer.from('isto não é JSON') };

    await expect(handleMessage(ch, msg)).resolves.toBeUndefined();
    expect(ch.ack).toHaveBeenCalledWith(msg);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
