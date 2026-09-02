import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

/**
 * Defesa contra SSRF (Server-Side Request Forgery).
 *
 * A API aceita uma `url` arbitrária e o worker faz POST nela — por
 * design. Sem isso, qualquer cliente pode usar o RaposaFM como proxy
 * pra atacar a rede interna: metadata de cloud (169.254.169.254), o
 * próprio painel do RabbitMQ (localhost:15672), ou qualquer serviço
 * atrás do firewall que só confia em tráfego "interno".
 *
 * Validado em dois momentos, não só um:
 * - na ingestão (API), pra rejeitar o óbvio o mais cedo possível;
 * - antes de cada tentativa de despacho (worker), porque o backoff
 *   pode espaçar tentativas por até 15 minutos — tempo de sobra pra um
 *   DNS rebinding attack trocar o IP por trás de um hostname que
 *   passou na primeira checagem.
 */

export class SsrfError extends Error {}

function isPrivateOrReservedIpv4(octets) {
  const [a, b] = octets;
  if (a === 127) return true; // loopback (127.0.0.0/8)
  if (a === 10) return true; // privado (10.0.0.0/8)
  if (a === 172 && b >= 16 && b <= 31) return true; // privado (172.16.0.0/12)
  if (a === 192 && b === 168) return true; // privado (192.168.0.0/16)
  if (a === 169 && b === 254) return true; // link-local, inclui metadata de cloud (169.254.0.0/16)
  if (a === 0) return true; // "esta rede" (0.0.0.0/8)
  if (a >= 224) return true; // multicast e reservado (224.0.0.0/4 em diante)
  return false;
}

export function isPrivateOrReservedIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    return isPrivateOrReservedIpv4(ip.split('.').map(Number));
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower.startsWith('fe80:')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local (fc00::/7)
    if (lower.startsWith('::ffff:')) {
      // IPv4 mapeado em IPv6 — extrai e reaplica a mesma checagem.
      const mapped = lower.slice('::ffff:'.length);
      if (net.isIP(mapped) === 4) return isPrivateOrReservedIpv4(mapped.split('.').map(Number));
    }
    return false;
  }
  return true; // nem é um IP reconhecível — trata como suspeito, não como válido
}

/**
 * Lança SsrfError se a URL não puder ser usada como destino de webhook.
 * Resolve o DNS e valida TODOS os IPs retornados, não só o primeiro.
 */
export async function assertPublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError('URL malformada');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError(`esquema "${parsed.protocol}" não permitido — use http ou https`);
  }

  if (config.allowPrivateNetworkUrls) return;

  const hostname = parsed.hostname;
  if (hostname.toLowerCase() === 'localhost') {
    throw new SsrfError('host "localhost" não é permitido');
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new SsrfError(`IP "${hostname}" pertence a uma faixa privada ou reservada`);
    }
    return;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new SsrfError(`não foi possível resolver "${hostname}": ${err.message}`);
  }

  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new SsrfError(`host "${hostname}" resolve para um IP privado (${address})`);
    }
  }
}
