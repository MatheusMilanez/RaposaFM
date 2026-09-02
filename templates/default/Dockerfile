# Imagem única para API e worker — docker-compose.yml decide qual dos
# dois roda em cada serviço, via `command:`.
#
# Multi-stage rende pouco aqui (não tem etapa de build, é JS puro),
# mas separa a instalação de dependências do runtime final e deixa o
# padrão pronto pra crescer. O ganho real é rodar como usuário sem
# privilégio — a imagem oficial já traz um "node" não-root pronto.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
USER node

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# Sem CMD fixo — cada serviço no docker-compose.yml define o seu.
