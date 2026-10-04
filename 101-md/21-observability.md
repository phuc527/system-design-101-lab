# 21 — Observability

> Monitoring tells you **that** something is wrong. Observability lets you ask **why** — about failures you never predicted — from the outside, using the data the system emits.

---

## 1. The problem

3 a.m. alert: "p99 latency 4 s". You have 12 services × 5 instances, Redis, PostgreSQL, Kafka. Questions:
- Which endpoint? Which instance? Since when?
- Is it the DB, a downstream service, GC, a bad deploy?
- Which users are affected?

Without telemetry you `ssh` into boxes and grep text logs. With observability you go from **dashboard → trace → logs** in minutes.

---

## 2. The three pillars (+1)

| Signal | What | Good for | Cost |
|---|---|---|---|
| **Metrics** | numeric time series (counters, gauges, histograms) | dashboards, alerts, trends | cheap, aggregated |
| **Logs** | discrete events with context | details of a specific event/error | expensive at volume |
| **Traces** | the path of one request across services (spans) | where time goes, which hop failed | sampled |
| Profiles | CPU/memory by function over time | why code is slow | continuous profiling tools |

They're linked by IDs: a metric spike → exemplar trace ID → trace → logs with the same `traceId`.

---

## 3. Structured logging

Text logs: `User 42 failed to pay order 9 because timeout` — hard to query.
Structured (JSON) logs: queryable fields.

```json
{"level":"error","time":"2026-10-04T03:12:09.120Z","service":"order-service","instance":"order-7f9c","requestId":"a1b2","traceId":"4bf92f35","userId":42,"orderId":9,"msg":"payment failed","err":{"type":"TimeoutError","message":"timeout after 2000ms"},"durationMs":2004}
```

```ts
import pino from "pino";
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<{ requestId: string }>();
export const logger = pino({
  base: { service: "order-service", instance: process.env.HOSTNAME },
  mixin: () => als.getStore() ?? {},          // inject requestId into every log line automatically
  redact: ["req.headers.authorization", "*.password", "*.cardNumber"],
});

app.use((req, res, next) => {
  const requestId = req.header("x-request-id") ?? crypto.randomUUID();
  res.setHeader("x-request-id", requestId);
  als.run({ requestId }, next);
});
```

Rules:
- JSON to stdout; the platform ships logs (Fluent Bit, Vector → Loki / Elasticsearch / CloudWatch)
- Levels: `error` (needs action), `warn`, `info` (business events), `debug` (off in prod)
- **Always** include `requestId`/`traceId`, service, instance
- **Never** log secrets, tokens, passwords, full card numbers, excessive PII
- Log **events**, not every line of code; sample noisy success logs

### Correlation / request IDs
Generate at the edge (gateway), propagate via headers (`X-Request-Id`, W3C `traceparent`) to every service and into message headers for queues. One ID → every log line from every service for that request.

---

## 4. Metrics

### Types (Prometheus)

| Type | Example | Notes |
|---|---|---|
| **Counter** | `http_requests_total` | only increases; use `rate()` |
| **Gauge** | `db_pool_in_use`, `queue_depth` | up and down |
| **Histogram** | `http_request_duration_seconds` | buckets → percentiles across instances |
| Summary | client-side quantiles | can't aggregate across instances — prefer histograms |

```ts
import client from "prom-client";

client.collectDefaultMetrics();   // event loop lag, heap, GC, CPU
const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on("finish", () => end({ method: req.method, route: req.route?.path ?? "unmatched", status: res.statusCode }));
  next();
});

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", client.register.contentType).send(await client.register.metrics());
});
```

PromQL:
```promql
# p99 latency per route
histogram_quantile(0.99, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))
# error rate
sum(rate(http_request_duration_seconds_count{status=~"5.."}[5m])) / sum(rate(http_request_duration_seconds_count[5m]))
```

⚠ **Cardinality**: every unique label combination is a separate time series. Never use `userId`, `orderId`, raw URL paths (`/orders/9812`) or error messages as labels → millions of series → Prometheus falls over. Use route templates (`/orders/:id`).

### What to measure — two methods

**RED** (for services / request-driven):
- **R**ate — requests/s
- **E**rrors — failed requests/s (or %)
- **D**uration — latency distribution (p50/p95/p99)

**USE** (for resources — CPU, memory, disks, pools, queues):
- **U**tilization — % busy
- **S**aturation — queued work (run queue, pool waiters, queue depth, event-loop lag)
- **E**rrors — resource errors

Google's **Four Golden Signals**: latency, traffic, errors, saturation.

Node.js-specific: **event-loop lag**, heap used, GC pauses, active handles, DB pool waiting count.

---

## 5. Distributed tracing

```text
trace 4bf92f35  (total 1,240 ms)
├─ gateway            GET /checkout                1240 ms
│  ├─ order-service   POST /orders                 1180 ms
│  │  ├─ postgres     INSERT orders                  12 ms
│  │  ├─ inventory    POST /reserve                  45 ms
│  │  └─ payment      POST /charge                 1090 ms  ← here
│  │     └─ stripe    POST /v1/charges             1070 ms
│  └─ redis           GET session                     1 ms
```

- **Trace** = one request end-to-end; **span** = one operation (name, start, duration, attributes, status, parent)
- Context propagated via W3C `traceparent` header (`00-<traceId>-<spanId>-01`)
- **OpenTelemetry** is the standard SDK: auto-instruments `http`, `express`, `pg`, `ioredis`, `kafkajs`; exports to Jaeger, Tempo, Zipkin, Honeycomb, Datadog…

```ts
// tracing.ts — load before anything else: node --import ./tracing.js server.js
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

new NodeSDK({
  serviceName: "order-service",
  traceExporter: new OTLPTraceExporter({ url: "http://otel-collector:4318/v1/traces" }),
  instrumentations: [getNodeAutoInstrumentations()],
}).start();
```

**Sampling**: tracing everything is expensive. Head sampling (decide at start, e.g. 10%) or **tail sampling** (collector keeps all errors and slow traces, samples the rest).

---

## 6. Dashboards and alerts

### Dashboard layout per service
1. RED: RPS, error %, p50/p95/p99 by route
2. Saturation: CPU, memory, event-loop lag, pool usage, queue depth/lag
3. Dependencies: latency/errors per downstream (DB, Redis, other services)
4. Deploy markers (annotations) — "did it start with the deploy?"

### Alerting
- Alert on **symptoms users feel** (error rate, latency SLO burn), not on every cause (CPU 80%)
- **SLO-based burn-rate alerts**: "we're consuming the monthly error budget 14× too fast over the last hour"
- Every alert must be **actionable** and link to a runbook; noisy alerts get ignored (alert fatigue)
- Page for urgent; ticket for slow-burn

---

## 7. Typical stack

```text
apps ──metrics /metrics──▶ Prometheus ──▶ Grafana (dashboards) + Alertmanager (alerts)
     ──logs stdout───────▶ Fluent Bit/Vector ──▶ Loki / Elasticsearch
     ──traces OTLP───────▶ OpenTelemetry Collector ──▶ Tempo / Jaeger
```
Managed alternatives: Datadog, New Relic, Grafana Cloud, Honeycomb, CloudWatch.

---

## 8. Debugging flow example

1. Alert: checkout p99 > 2 s
2. Grafana: p99 up only on `POST /orders`, all instances → not one bad box
3. Dependency panel: `payment` client latency up
4. Click exemplar → trace → `stripe POST /v1/charges` 1 s+
5. Logs filtered by `traceId`: retries with `ETIMEDOUT`
6. Action: confirm provider incident; circuit breaker/fallback (queue charges); update status page

---

## 9. Production checklist

- [ ] JSON logs with requestId/traceId, service, instance; secrets redacted
- [ ] Request ID generated at edge and propagated (HTTP + message headers)
- [ ] RED metrics per route; USE metrics for pools/queues; Node runtime metrics
- [ ] Label cardinality reviewed
- [ ] OpenTelemetry tracing with sensible sampling
- [ ] Dashboards per service + dependency view + deploy annotations
- [ ] SLOs defined; burn-rate alerts with runbooks
- [ ] Log retention and cost controls

---

## 10. Interview questions

1. **Monitoring vs observability?** — Monitoring checks known failure conditions; observability lets you investigate unknown ones from rich telemetry.
2. **Logs vs metrics vs traces?** — Events with detail / cheap aggregated numbers / per-request causal path.
3. **What are RED and USE?** — Rate-Errors-Duration for services; Utilization-Saturation-Errors for resources.
4. **Why histograms over averages?** — Percentiles, aggregatable across instances.
5. **What is high cardinality and why does it matter?** — Too many label combinations explode time series and cost.
6. **How do you trace a request across services?** — Propagate trace context (`traceparent`), instrument with OpenTelemetry, collect spans.
7. **What makes a good alert?** — Symptom-based, tied to SLOs, actionable, with a runbook.

**Prev:** [20 — Idempotency](20-idempotency.md) · **Next:** [22 — Horizontal Scaling](22-horizontal-scaling.md)
