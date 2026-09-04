import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Pool de conexões PostgreSQL, compartilhado entre API e worker.
 *
 * Diferente da conexão AMQP (amqp.js), o pg.Pool já gerencia sozinho a
 * abertura, reuso e recriação de conexões por trás de cada query — não
 * precisa da dança manual de reconexão com backoff que o AMQP exige.
 * O único cuidado necessário é tratar o evento 'error' de clientes
 * ociosos no pool: sem um listener, um erro aí (ex.: o Postgres
 * derrubando a conexão) derruba o processo inteiro.
 */

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl });
    pool.on('error', (err) => {
      logger.error('postgres: erro em cliente ocioso do pool', { error: err.message });
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}
