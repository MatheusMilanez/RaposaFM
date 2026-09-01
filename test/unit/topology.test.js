import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { assertTopology, EXCHANGE, QUEUES, ROUTING_KEYS } from '../../src/shared/topology.js';

function fakeChannel() {
  return {
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn().mockResolvedValue(undefined),
  };
}

describe('assertTopology', () => {
  let ch;

  beforeEach(() => {
    ch = fakeChannel();
  });

  test('declara o exchange como direct e durável', async () => {
    await assertTopology(ch);
    expect(ch.assertExchange).toHaveBeenCalledWith(EXCHANGE, 'direct', { durable: true });
  });

  test('declara as 3 filas, todas duráveis', async () => {
    await assertTopology(ch);
    expect(ch.assertQueue).toHaveBeenCalledTimes(3);
    for (const call of ch.assertQueue.mock.calls) {
      expect(call[1]).toMatchObject({ durable: true });
    }
    const queueNames = ch.assertQueue.mock.calls.map((call) => call[0]);
    expect(queueNames).toEqual(expect.arrayContaining([QUEUES.delivery, QUEUES.wait, QUEUES.dlq]));
  });

  test('a fila de espera tem dead-letter apontando de volta pra entrega', async () => {
    await assertTopology(ch);
    const waitCall = ch.assertQueue.mock.calls.find((call) => call[0] === QUEUES.wait);
    expect(waitCall[1].arguments).toEqual({
      'x-dead-letter-exchange': EXCHANGE,
      'x-dead-letter-routing-key': ROUTING_KEYS.deliver,
    });
  });

  test('cada fila é ligada ao exchange com a routing key certa', async () => {
    await assertTopology(ch);
    expect(ch.bindQueue).toHaveBeenCalledWith(QUEUES.delivery, EXCHANGE, ROUTING_KEYS.deliver);
    expect(ch.bindQueue).toHaveBeenCalledWith(QUEUES.wait, EXCHANGE, ROUTING_KEYS.wait);
    expect(ch.bindQueue).toHaveBeenCalledWith(QUEUES.dlq, EXCHANGE, ROUTING_KEYS.dlq);
  });
});
