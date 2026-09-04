// Carregado antes de qualquer teste (jest.config.js -> setupFiles).
// src/shared/config.js falha rápido se RABBITMQ_URL não estiver definida,
// e vários módulos a importam transitivamente — os testes nunca conectam
// de verdade num broker, mas a variável precisa existir para os módulos
// carregarem. Os valores de retry são pequenos e determinísticos de
// propósito, para as asserções de tempo dos testes unitários.
process.env.RABBITMQ_URL ??= 'amqp://test:test@localhost:5672/';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.API_PORT ??= '0';
process.env.WORKER_PREFETCH ??= '10';
// 5 (não 3) de propósito: maior que o tamanho da escada de backoff abaixo,
// pra existir um caminho de teste onde o degrau final se repete antes de
// esgotar — ver test/unit/retryPolicy.test.js.
process.env.MAX_RETRIES ??= '5';
process.env.HTTP_TIMEOUT_MS ??= '2000';
process.env.RETRY_BACKOFF_MS ??= '1000,2000,4000';
process.env.LOG_LEVEL ??= 'error'; // silencia log de info/warn durante os testes
