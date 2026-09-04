# RaposaFM

![RaposaFM](assets/logo.png)

[![CI](https://github.com/MatheusMilanez/RaposaFM/actions/workflows/ci.yml/badge.svg)](https://github.com/MatheusMilanez/RaposaFM/actions/workflows/ci.yml)

Despachante de webhooks self-hosted. Em vez da sua aplicação chamar o destino final direto e torcer pra dar certo, ela manda o evento pro RaposaFM — que responde na hora e assume a entrega, com retentativas espaçadas e uma fila de cartas mortas pra quando nada mais funciona.

## Por quê

Webhook direto quebra fácil: a rede cai, o destino está fora do ar, o servidor do outro lado entrou em cold start. Se isso acontece no segundo exato do disparo, o evento simplesmente some — sem log, sem segunda chance. Dá pra pagar um Svix ou um Hookdeck pra resolver isso, ou rodar essa versão self-hosted.

## Como funciona

```
[Sistema de origem]
      │  POST /api/v1/webhooks
      ▼
┌─────────────────────────┐
│   API (Fastify)         │  valida, publica no broker,
│                         │  responde 202 em milissegundos
└───────────┬─────────────┘
            │ AMQP (publisher confirms)
            ▼
┌─────────────────────────┐
│   RabbitMQ              │  persiste em disco,
│                         │  controla retry (TTL) e DLQ
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│   Worker(s)             │  consome, dispara o POST real,
│                         │  decide retry/DLQ pelo resultado
└───────────┬─────────────┘
            ▼
   [Destino final]
```

A API só garante que o evento foi recebido com segurança — quem entrega de fato é o worker, rodando à parte. Isso é o que permite responder em milissegundos mesmo quando o destino está lento ou fora do ar: a ingestão nunca espera a entrega terminar.

Antes de publicar, a API registra a tarefa no PostgreSQL (motor de idempotência, M9). Um header `Idempotency-Key` opcional protege contra reentrega quando o mesmo pedido chega mais de uma vez — retry de rede do lado de quem chama, por exemplo: a chave já vista faz a API responder com o `messageId` da tarefa original, sem publicar (nem entregar) de novo.

Quando a entrega falha, o worker classifica o erro. Falha transitória (5xx, timeout, conexão recusada) entra num ciclo de espera crescente — 1 minuto, depois 5, depois 15 — usando o próprio TTL do RabbitMQ pra isso, sem nenhum `setTimeout` no código. Falha permanente (um 4xx, por exemplo) vai direto pra fila de cartas mortas, sem insistir num erro que já foi respondido como definitivo.

## Stack

| Camada       | Ferramenta                          |
| ------------ | ----------------------------------- |
| Runtime      | Node.js 18+, ESM                    |
| API          | Fastify                             |
| Broker       | RabbitMQ 3                          |
| Driver AMQP  | `amqplib`                           |
| Persistência | PostgreSQL 16                       |
| Driver SQL   | `pg`                                |
| Testes       | Jest, Supertest, Testcontainers, k6 |
| CI           | GitHub Actions                      |
| Infra local  | Docker Compose                      |

## Rodando

Pré-requisitos: Docker, Docker Compose e Node 18+.

```bash
cp .env.example .env   # ajuste a senha do RabbitMQ e do PostgreSQL
docker compose up -d   # sobe RabbitMQ, PostgreSQL (com o schema já migrado), API e worker
curl http://localhost:3000/health
```

A API só entra no ar depois do RabbitMQ passar no healthcheck — não precisa esperar na mão. Pra rodar mais de um worker:

```bash
docker compose up -d --scale worker=3
```

Testando a ingestão:

```bash
curl -X POST http://localhost:3000/api/v1/webhooks \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: chave-opcional-do-seu-lado" \
  -d '{"url": "https://httpbin.org/status/200", "payload": {"evento": "teste"}}'
```

Deve voltar `202` com um `messageId`. Repetir a mesma chamada com o mesmo `Idempotency-Key` responde com o `messageId` da tentativa original, sem publicar (nem entregar) de novo. Pra acompanhar a entrega, `docker compose logs worker -f`, ou o painel do RabbitMQ em [localhost:15672](http://localhost:15672).

### Variáveis de ambiente

Tudo em [`.env.example`](.env.example). `RABBITMQ_URL` e `DATABASE_URL` são obrigatórias — o resto tem padrão.

| Variável                     | Padrão                | O que faz                                                              |
| ---------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `RABBITMQ_USER`              | `raposafm`            | Usuário criado no container do RabbitMQ                                |
| `RABBITMQ_PASSWORD`          | — (obrigatória)       | Sem valor fixo de propósito                                            |
| `RABBITMQ_URL`               | — (obrigatória)       | String de conexão AMQP                                                 |
| `POSTGRES_USER`              | `raposafm`            | Usuário criado no container do PostgreSQL                              |
| `POSTGRES_PASSWORD`          | — (obrigatória)       | Sem valor fixo de propósito                                            |
| `POSTGRES_DB`                | `raposafm`            | Banco criado no container do PostgreSQL                                |
| `DATABASE_URL`               | — (obrigatória)       | String de conexão usada pela API e pelo runner de migrações            |
| `API_PORT`                   | `3000`                | Porta da API                                                           |
| `ALLOW_PRIVATE_NETWORK_URLS` | `false`               | Libera webhook pra IP privado/localhost — só em dev, nunca em produção |
| `WORKER_PREFETCH`            | `10`                  | Mensagens em paralelo por worker                                       |
| `MAX_RETRIES`                | `5`                   | Tentativas antes de cair na DLQ                                        |
| `HTTP_TIMEOUT_MS`            | `5000`                | Timeout de cada tentativa de entrega                                   |
| `RETRY_BACKOFF_MS`           | `60000,300000,900000` | Degraus do backoff, em ms                                              |
| `LOG_LEVEL`                  | `info`                | `debug` \| `info` \| `warn` \| `error`                                 |

### Sem Docker

Com o RabbitMQ e o PostgreSQL no ar (`docker compose up -d rabbitmq postgres`):

```bash
npm install
npm run migrate:up   # cria o schema no PostgreSQL
npm run start:api    # um terminal
npm run start:worker # outro
```

## Teste de carga

Scripts em [`scripts/load/`](scripts/load/), via [k6](https://k6.io/), contra a stack real (com um destino de eco local, pra não martelar serviço de terceiros):

```bash
npm run test:load    # baseline + ramp-up + pico
npm run test:stress  # empurra até o ponto de quebra
```

Números de referência (01/09/2026, 1 réplica de API e de worker, sem tuning nenhum):

- Baseline/ramp-up/pico, 20.777 requisições, até 100 VUs simultâneos: `p95 166ms`, `p99 224ms`, 0% de erro
- 5.419 mensagens acumuladas, drenadas por 1 worker em 12s
- Sob 1000 VUs simultâneos: 98,31% respondeu `202`/`503` normalmente; o resto estourou o timeout de 10s do cliente — não crash, latência mesmo. É o teto real desta configuração.

Rode localmente antes de usar como referência — os números mudam de máquina pra máquina.
