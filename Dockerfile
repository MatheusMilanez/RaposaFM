# Imagem única para API e worker — docker-compose.yml decide qual dos
# dois roda em cada serviço, via `command:`.
FROM node:22-alpine

WORKDIR /app

# Copia só o necessário pra instalar antes do código: cache de camada
# do Docker não invalida a cada mudança de código-fonte.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Sem CMD fixo — cada serviço no docker-compose.yml define o seu.
