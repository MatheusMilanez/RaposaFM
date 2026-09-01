import amqp from 'amqplib';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Conexão AMQP resiliente, compartilhada entre API e worker.
 *
 * Mantém uma única connection reaproveitada pelo processo; cada contexto
 * de uso (o publisher da API, cada worker) abre o seu próprio channel em
 * cima dela via getChannel(). Se a connection cair, o módulo tenta
 * reconectar sozinho com espera exponencial — quem chama getChannel()
 * nesse meio-tempo recebe um erro, e decide o que fazer (a API responde
 * 503, por exemplo).
 */

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

let connection = null;
let connectingPromise = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let stopped = false;

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY_MS);
  reconnectAttempts += 1;
  logger.warn('amqp: agendando reconexão', { emMs: delay, tentativa: reconnectAttempts });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function connect() {
  if (stopped || connection || connectingPromise) return connectingPromise;

  connectingPromise = amqp
    .connect(config.rabbitmqUrl)
    .then((conn) => {
      connection = conn;
      connectingPromise = null;
      reconnectAttempts = 0;
      logger.info('amqp: conectado');

      conn.on('error', (err) => {
        // 'close' é sempre emitido logo em seguida — a reconexão é agendada lá,
        // aqui só registramos o motivo.
        logger.error('amqp: erro na conexão', { error: err.message });
      });

      conn.on('close', () => {
        logger.warn('amqp: conexão encerrada');
        connection = null;
        scheduleReconnect();
      });
    })
    .catch((err) => {
      connectingPromise = null;
      logger.error('amqp: falha ao conectar', { error: err.message });
      scheduleReconnect();
    });

  return connectingPromise;
}

/** Inicia a conexão em segundo plano. Não bloqueia nem lança erro. */
export function startAmqp() {
  stopped = false;
  connect();
}

export function isAmqpConnected() {
  return connection !== null;
}

/**
 * Abre um channel novo na connection atual. Lança erro imediatamente se
 * não houver connection ativa — quem chama decide como reagir (ex.: a
 * rota de ingestão responde 503 em vez de ficar esperando).
 */
export async function getChannel() {
  if (!connection) {
    throw new Error('sem conexão ativa com o RabbitMQ');
  }
  return connection.createChannel();
}

export async function closeAmqp() {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (connection) {
    await connection.close().catch(() => {});
    connection = null;
  }
}
