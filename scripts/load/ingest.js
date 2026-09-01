import http from 'k6/http';
import { check } from 'k6';

// Rodado via `docker run --network ...`, então o alvo é o nome do
// serviço no compose, não localhost. API_URL sobrescreve pra rodar de
// outro jeito.
const API_URL = __ENV.API_URL || 'http://api:3000';
const DEST_URL = __ENV.DEST_URL || 'http://echo-destination:8080/';

export const options = {
  scenarios: {
    // Carga constante e moderada — referência de latência normal.
    baseline: {
      executor: 'constant-vus',
      vus: 10,
      duration: '20s',
      exec: 'ingest',
      startTime: '0s',
    },
    // Sobe gradualmente, pra ver onde a latência começa a crescer.
    ramp_up: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 50 },
        { duration: '10s', target: 50 },
        { duration: '5s', target: 0 },
      ],
      exec: 'ingest',
      startTime: '25s',
    },
    // Rajada curta e intensa — simula disparo em massa de origem.
    pico: {
      executor: 'constant-vus',
      vus: 100,
      duration: '5s',
      exec: 'ingest',
      startTime: '55s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300', 'p(99)<800'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export function ingest() {
  const res = http.post(
    `${API_URL}/api/v1/webhooks`,
    JSON.stringify({
      url: DEST_URL,
      payload: { origem: 'k6', vu: __VU, iter: __ITER },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(res, { 'status é 202': (r) => r.status === 202 });
}
