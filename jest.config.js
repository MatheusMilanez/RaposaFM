/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  // Sem transformação: o código já é ESM nativo, não precisa de babel.
  transform: {},
  setupFiles: ['<rootDir>/test/setup.js'],
  // test/e2e fica de fora daqui de propósito: sobe container Docker de
  // verdade, é lento, e roda com uma config própria (jest.e2e.config.js).
  testMatch: ['**/test/unit/**/*.test.js', '**/test/integration/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js'],
  coveragePathIgnorePatterns: [
    // Entrypoints: só orquestram os módulos já testados isoladamente.
    'src/api/server.js',
    'src/worker/index.js',
    // Wrappers finos sobre o Channel/Connection do amqplib. Testar de
    // verdade exigiria um broker real ou reimplementar boa parte da
    // semântica do amqplib num mock — coberto pelo e2e com Testcontainers
    // (test/e2e/webhook-flow.test.js, issue #31), não por unitário. O
    // comportamento deles também já foi validado manualmente e a fundo
    // nas M2/M3 (queda e recuperação de broker real, timings de backoff
    // cronometrados). consumer.js NÃO está nessa lista: sua lógica de
    // decisão (handleMessage) é testada com channel fake em
    // test/unit/consumer.test.js — só o encanamento do amqplib em volta
    // (prefetch/consume/cancel) fica de fora, coberto pelo e2e.
    'src/shared/amqp.js',
    'src/api/publisher.js',
    // Mesmo raciocínio, agora para o PostgreSQL (M9): pool real (db.js),
    // runner de migração e motor de tarefas (taskQueue.js) só fazem
    // sentido testados contra um banco de verdade — coberto pelo e2e com
    // Testcontainers (test/e2e/db-schema.test.js, test/e2e/task-queue.test.js).
    'src/shared/db.js',
    'src/db/migrate.js',
    'src/db/taskQueue.js',
    'src/db/cleanup.js',
  ],
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 80,
      functions: 90,
      lines: 90,
    },
    // handleMessage (a lógica de decisão) tem cobertura unitária real;
    // startConsumer/stopConsumer (o encanamento com o amqplib real —
    // prefetch, consume, cancel) ficam pro e2e, não dá pra mockar bem
    // sem reimplementar o amqplib. Limite mais baixo só aqui, não um
    // exclude total do arquivo.
    './src/worker/consumer.js': {
      statements: 40,
      branches: 20,
      functions: 10,
      lines: 40,
    },
  },
};
