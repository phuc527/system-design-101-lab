// k6 load test through the load balancer.
//
// From the 01-load-balancer folder (Git Bash):
//   docker run --rm -i -e BASE_URL=http://host.docker.internal:8090 grafana/k6 run - < k6/load-test.js
//
// Options (environment variables):
//   BASE_URL   default http://host.docker.internal:8090   (use :8091 for the TypeScript LB)
//   ENDPOINT   default /work?ms=100   (simulated DB query; ~100 req/s capacity per instance)
//   MAX_VUS    default 30
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:8090";
const ENDPOINT = __ENV.ENDPOINT || "/work?ms=100";
const MAX_VUS = Number(__ENV.MAX_VUS || 30);

// One counter per instance, so the summary shows how the LB spread the load.
const servedBy = {
  api1: new Counter("served_by_api1"),
  api2: new Counter("served_by_api2"),
  api3: new Counter("served_by_api3"),
};

export const options = {
  stages: [
    { duration: "10s", target: MAX_VUS },
    { duration: "20s", target: MAX_VUS },
    { duration: "5s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1000"],
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};

export default function () {
  const res = http.get(`${BASE_URL}${ENDPOINT}`);
  check(res, { "status is 200": (r) => r.status === 200 });
  const instance = res.headers["X-Instance"];
  if (servedBy[instance]) servedBy[instance].add(1);
}
