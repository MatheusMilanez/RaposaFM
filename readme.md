# RaposaFM 🦊

[![CI](https://github.com/MatheusMilanez/RaposaFM/actions/workflows/ci.yml/badge.svg)](https://github.com/MatheusMilanez/RaposaFM/actions/workflows/ci.yml)

> Um despachante de webhooks assíncrono, leve e _self-hosted_, focado em confiabilidade, resiliência e alta performance.

---

## 💡 O Problema

Sistemas modernos precisam se comunicar constantemente por meio de webhooks (notificações HTTP). No entanto, o mundo real da infraestrutura é instável:

- Redes falham e servidores caem inesperadamente.
- Aplicações em ambientes _serverless_ sofrem com _cold starts_ e _timeouts_.
- Se o servidor de destino estiver fora do ar no exato momento do disparo, o evento original é perdido, gerando dados dessincronizados e falhas de integração.

Ferramentas comerciais para gerenciar e garantir a entrega de webhooks (como Svix ou Hookdeck) costumam ser caras e proprietárias.

## 🚀 A Solução

O **RaposaFM** atua como um intermediário inteligente e resiliente. Em vez de sua aplicação disparar webhooks diretamente para a internet e torcer para que o destino responda, ela envia o pacote para o **RaposaFM**.

O sistema absorve o impacto instantaneamente, enfileira a mensagem de forma segura e assume a responsabilidade de entregá-la ao destino final, gerenciando falhas e tentativas de reenvio em segundo plano.

---

## ⚙️ Principais Funcionalidades

1. **Motor de Ingestão Assíncrona (`202 Accepted`):** a API em Fastify recebe o webhook, valida o payload rapidamente e devolve um `202 Accepted` em milissegundos, enquanto joga a tarefa de forma segura no RabbitMQ.
2. **Sistema de Workers Concorrentes:** processos em segundo plano que consomem as filas e despacham as requisições HTTP para os servidores de destino em paralelo, garantindo alta vazão.
3. **Mecanismo de Retentativas (_Exponential Backoff_):** lógica no worker para interceptar falhas de rede ou erros do servidor de destino (como um `500` ou um _timeout_) e reagendar o reenvio de forma espaçada (ex.: 1 minuto, depois 5, depois 15).
4. **Fila de Cartas Mortas (_Dead Letter Queue_ - DLQ):** destino final para os webhooks que esgotaram todas as tentativas de entrega, evitando que fiquem presos em _looping_ infinito e permitindo a inspeção do erro.
5. **Experiência de Uso Simples (_Developer Experience_):** o projeto roda 100% via Docker Compose com um único comando (`docker compose up -d`), permitindo que qualquer desenvolvedor suba a infraestrutura e teste o sistema na própria máquina instantaneamente.

---

## 🧰 Stack Tecnológica e Ferramentas

Para garantir robustez ao **RaposaFM**, a arquitetura utiliza ferramentas consolidadas no mercado de backend:

| Camada               | Ferramenta                                                             |
| -------------------- | ---------------------------------------------------------------------- |
| Runtime & Linguagem  | Node.js (v18+) com JavaScript/ESM moderno                              |
| Framework Web        | Fastify (alta performance na ingestão de requisições)                  |
| Message Broker       | RabbitMQ 3 (gerenciamento de filas e persistência)                     |
| Driver AMQP          | `amqplib` (comunicação oficial entre Node.js e RabbitMQ)               |
| Testes               | Jest (unitários e de integração) e Supertest (validação de rotas HTTP) |
| CI/CD                | GitHub Actions (automação de build, testes e linting)                  |
| Infraestrutura Local | Docker & Docker Compose                                                |

---

## 🏛️ Arquitetura

A arquitetura do **RaposaFM** é baseada em microsserviços assíncronos orientados a mensageria (_Message-Driven Architecture_), desenhada para desacoplar a ingestão de requisições da entrega pesada de rede.

O fluxo estrutural funciona em camadas bem definidas:

```
[Sistemas de Origem (Python, Go, PHP, etc.)]
                    │
                    │ HTTP POST /api/v1/webhooks
                    ▼
┌────────────────────────────────────────────────────────┐
│             API de Ingestão (Node.js + Fastify)        │
│  - Recebe e valida o payload instantaneamente          │
│  - Publica a mensagem no Message Broker                │
│  - Responde imediatamente com [ 202 Accepted ]         │
└───────────────────┬────────────────────────────────────┘
                    │
                    │ AMQP Protocol (Publicação segura)
                    ▼
┌────────────────────────────────────────────────────────┐
│             Message Broker (RabbitMQ)                  │
│  - Gerencia a persistência das filas                   │
│  - Controla Dead Letter Queues (DLQ) e TTL (Retries)   │
└───────────────────┬────────────────────────────────────┘
                    │
                    │ Consumo Assíncrono e Concorrente
                    ▼
┌────────────────────────────────────────────────────────┐
│             Camada de Workers (Node.js)                │
│  - Processa mensagens em segundo plano                 │
│  - Dispara requisições HTTP para o destino final       │
│  - Executa Exponential Backoff em caso de falha        │
└───────────────────┬────────────────────────────────────┘
                    │
                    │ HTTP POST (Webhook)
                    ▼
          [Servidor de Destino / Cliente Final]
```

### Detalhamento dos Componentes

1. **Camada de Ingestão (API Fastify):** atua como a porta de entrada, otimizada para alta performance e baixa latência. O objetivo dela não é entregar o webhook, mas garantir que o evento foi recebido com segurança, registrá-lo na fila e liberar o sistema de origem em poucos milissegundos através do status `202 Accepted`.
2. **Camada de Enfileiramento (RabbitMQ):** o coração do desacoplamento. Garante durabilidade (as mensagens ficam salvas em disco, sobrevivendo a quedas de energia ou reboots do container) e permite o balanceamento de carga, distribuindo as tarefas igualmente entre vários workers ativos.
3. **Camada de Processamento (Workers):** processos independentes que escutam a fila em segundo plano. Controlam o paralelismo, evitam gargalos de memória e executam a lógica de resiliência: se o servidor de destino falhar, o worker calcula o tempo de espera crescente (_exponential backoff_) e programa uma nova tentativa, ou encaminha o pacote para a DLQ caso o limite de erros seja atingido.

---

## 🛠️ Como Executar o Projeto

### Pré-requisitos

- Docker e Docker Compose instalados na sua máquina.
- Node.js (versão 18 ou superior).

### 1. Configurar as variáveis de ambiente

Copie o `.env.example` para `.env` e ajuste a senha do RabbitMQ:

```bash
cp .env.example .env
```

### 2. Subir tudo com um comando

Na raiz do projeto:

```bash
docker compose up -d
```

Isso sobe o RabbitMQ, a API e o worker — a API só entra no ar depois do broker passar no healthcheck. Confirme com:

```bash
curl http://localhost:3000/health
```

Pra escalar o número de workers:

```bash
docker compose up -d --scale worker=3
```

### 3. Testar a ingestão

```bash
curl -X POST http://localhost:3000/api/v1/webhooks \
  -H "Content-Type: application/json" \
  -d '{"url": "https://httpbin.org/status/200", "payload": {"evento": "teste"}}'
```

Deve responder `202 Accepted` com um `messageId`. Acompanhe a entrega em `docker compose logs worker -f`, ou inspecione as filas no painel do RabbitMQ em [http://localhost:15672](http://localhost:15672).

### Variáveis de ambiente

Todas em [`.env.example`](.env.example). Só `RABBITMQ_URL` é obrigatória de verdade — o resto tem valor padrão.

| Variável                     | Padrão                | Descrição                                                                                      |
| ---------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `RABBITMQ_USER`              | `raposafm`            | Usuário administrador criado no container do RabbitMQ                                          |
| `RABBITMQ_PASSWORD`          | — (obrigatória)       | Senha do RabbitMQ; sem valor fixo de propósito                                                 |
| `RABBITMQ_URL`               | — (obrigatória)       | String de conexão AMQP usada pela API e pelo worker                                            |
| `API_PORT`                   | `3000`                | Porta em que a API escuta                                                                      |
| `ALLOW_PRIVATE_NETWORK_URLS` | `false`               | Libera webhook apontando pra IP privado/localhost — só para desenvolvimento, nunca em produção |
| `WORKER_PREFETCH`            | `10`                  | Quantas mensagens cada worker processa em paralelo                                             |
| `MAX_RETRIES`                | `5`                   | Tentativas totais antes de uma mensagem ir para a DLQ                                          |
| `HTTP_TIMEOUT_MS`            | `5000`                | Timeout de cada tentativa de entrega ao destino                                                |
| `RETRY_BACKOFF_MS`           | `60000,300000,900000` | Degraus do backoff exponencial (1min, 5min, 15min), em ms                                      |
| `LOG_LEVEL`                  | `info`                | `debug` \| `info` \| `warn` \| `error`                                                         |

### Rodando fora do Docker (desenvolvimento)

Com o RabbitMQ no ar (`docker compose up -d rabbitmq`), rode a API e o worker localmente com Node 18+:

```bash
npm install
npm run start:api    # em um terminal
npm run start:worker # em outro
```

---

## 📈 Teste de Carga

Scripts em [`scripts/load/`](scripts/load/), rodados via [k6](https://k6.io/) contra a stack real do Docker Compose (com um destino local de eco, pra não martelar um serviço de terceiros):

```bash
npm run test:load    # baseline + ramp-up + pico (ingest.js)
npm run test:stress  # empurra a carga até o ponto de quebra (stress.js)
```

**Resultado de referência** (01/09/2026, 1 réplica de API e de worker, sem tuning):

| Cenário                                                                 | Resultado                                                                                                                                                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline + ramp-up + pico (20.777 requisições, até 100 VUs simultâneos) | `p95 = 166ms`, `p99 = 224ms`, **0% de erro**                                                                                                                                     |
| Tempo de drenagem (5.419 mensagens acumuladas processadas por 1 worker) | **12s**                                                                                                                                                                          |
| Estresse (até 1000 VUs simultâneos)                                     | **98,31%** respondeu `202`/`503` normalmente; o restante estourou o timeout de 10s do cliente — esse é o teto real de capacidade desta configuração, não uma falha descontrolada |

Números variam por máquina — rode localmente antes de usar como referência de capacidade real.
