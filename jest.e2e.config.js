/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['**/test/e2e/**/*.test.js'],
  // Testcontainers sobe um container Docker de verdade por suíte — mais
  // lento que o padrão de 5s do Jest, principalmente puxando a imagem
  // pela primeira vez.
  testTimeout: 60000,
  // Sem setupFiles: cada teste e2e define suas próprias variáveis de
  // ambiente antes de importar os módulos da aplicação, porque a URL
  // real do broker só existe depois do container subir.
};
