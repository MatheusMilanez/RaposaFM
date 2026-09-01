import { describe, test, expect, jest, beforeEach } from '@jest/globals';

const lookupMock = jest.fn();

jest.unstable_mockModule('node:dns/promises', () => ({
  default: { lookup: lookupMock },
  lookup: lookupMock,
}));

const { assertPublicUrl, isPrivateOrReservedIp, SsrfError } =
  await import('../../src/shared/ssrfGuard.js');

describe('isPrivateOrReservedIp', () => {
  test.each([
    ['127.0.0.1', true, 'loopback'],
    ['10.0.0.5', true, 'privado 10/8'],
    ['172.16.0.1', true, 'privado 172.16/12, início da faixa'],
    ['172.31.255.255', true, 'privado 172.16/12, fim da faixa'],
    ['172.32.0.1', false, 'logo fora da faixa 172.16/12'],
    ['192.168.1.1', true, 'privado 192.168/16'],
    ['169.254.169.254', true, 'link-local, metadata de cloud'],
    ['0.0.0.0', true, '"esta rede"'],
    ['224.0.0.1', true, 'multicast'],
    ['8.8.8.8', false, 'público (Google DNS)'],
    ['1.1.1.1', false, 'público (Cloudflare DNS)'],
    ['::1', true, 'loopback IPv6'],
    ['fe80::1', true, 'link-local IPv6'],
    ['fd00::1', true, 'unique local IPv6 (fc00::/7)'],
    ['2001:4860:4860::8888', false, 'público IPv6 (Google DNS)'],
    ['::ffff:127.0.0.1', true, 'IPv4 mapeado em IPv6, loopback'],
  ])('%s -> %s (%s)', (ip, expected) => {
    expect(isPrivateOrReservedIp(ip)).toBe(expected);
  });
});

describe('assertPublicUrl', () => {
  beforeEach(() => lookupMock.mockReset());

  test('rejeita esquema diferente de http/https', async () => {
    await expect(assertPublicUrl('ftp://exemplo.com')).rejects.toThrow(SsrfError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test('rejeita URL malformada', async () => {
    await expect(assertPublicUrl('não é uma url')).rejects.toThrow(SsrfError);
  });

  test('rejeita "localhost" explicitamente, sem precisar de DNS', async () => {
    await expect(assertPublicUrl('http://localhost:3000')).rejects.toThrow(SsrfError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test('rejeita IP privado literal na URL, sem precisar de DNS', async () => {
    await expect(assertPublicUrl('http://192.168.1.1/hook')).rejects.toThrow(SsrfError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test('aceita IP público literal, sem precisar de DNS', async () => {
    await expect(assertPublicUrl('http://8.8.8.8/hook')).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test('resolve o hostname e rejeita se qualquer um dos IPs retornados for privado', async () => {
    lookupMock.mockResolvedValue([{ address: '8.8.8.8' }, { address: '10.0.0.1' }]);
    await expect(assertPublicUrl('http://exemplo-malicioso.com')).rejects.toThrow(SsrfError);
  });

  test('resolve o hostname e aceita se todos os IPs forem públicos', async () => {
    lookupMock.mockResolvedValue([{ address: '8.8.8.8' }, { address: '1.1.1.1' }]);
    await expect(assertPublicUrl('http://exemplo.com')).resolves.toBeUndefined();
  });

  test('rejeita se a resolução DNS falhar', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertPublicUrl('http://nao-existe.invalido')).rejects.toThrow(SsrfError);
  });
});
