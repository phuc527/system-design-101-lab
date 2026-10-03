// k6 load test - ramps virtual users (VUs) up and down and reports latency percentiles.
//
// Run with Docker (no install needed). From the 00-basics folder, in Git Bash:
//   docker run --rm -i -e BASE_URL=http://host.docker.internal:3001 grafana/k6 run - < k6/load-test.js
//
// Options (environment variables):
//   BASE_URL   default http://host.docker.internal:3001
//   ENDPOINT   default /api/latency?ms=50
//   MAX_VUS    default 100
import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:3001";
const ENDPOINT = __ENV.ENDPOINT || "/api/latency?ms=50";
const MAX_VUS = Number(__ENV.MAX_VUS || 100);

export const options = {
  // Ramp up -> hold -> ramp down. Watch how latency changes as load grows.
  stages: [
    { duration: "10s", target: Math.round(MAX_VUS / 4) },
    { duration: "20s", target: MAX_VUS },
    { duration: "10s", target: 0 },
  ],
  // The test "fails" if these SLOs are violated - exactly how SLOs work in production.
  thresholds: {
    http_req_failed: ["rate<0.01"], // < 1% errors
    http_req_duration: ["p(95)<500"], // 95% of requests under 500ms
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export default function () {
  const res = http.get(`${BASE_URL}${ENDPOINT}`);
  check(res, { "status is 200": (r) => r.status === 200 });
}
