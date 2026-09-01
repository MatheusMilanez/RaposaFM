/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  // Sem transformação: o código já é ESM nativo, não precisa de babel.
  transform: {},
  setupFiles: ['<rootDir>/test/setup.js'],
  testMatch: ['**/test/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js'],
  coveragePathIgnorePatterns: [
    // Entrypoints: só orquestram os módulos já testados isoladamente.
    'src/api/server.js',
    'src/worker/index.js',
    // Wrappers finos sobre o Channel/Connection do amqplib. Testar de
    // verdade exigiria um broker real ou reimplementar boa parte da
    // semântica do amqplib num mock — isso é objetivo da M6 (e2e com
    // Testcontainers, issue #31), não desta etapa. O comportamento deles
    // já foi validado manualmente e a fundo nas M2/M3 (queda e
    // recuperação de broker real, timings de backoff cronometrados).
    'src/shared/amqp.js',
    'src/api/publisher.js',
    'src/worker/consumer.js',
  ],
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 80,
      functions: 90,
      lines: 90,
    },
  },
};
