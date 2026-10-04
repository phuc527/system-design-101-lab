# 17 — Health Check

> "Is it up?" is three different questions: Is the process alive? Can it take traffic right now? Are its dependencies OK? Mixing them up causes outages.

---

## 1. The problem

Load balancers, orchestrators, and service discovery need to know whether to **send traffic** to an instance and whether to **restart** it.

A naive `/health` returning `200 OK` always:
- says "healthy" while the DB pool is exhausted → users get 500s
- says "healthy" during startup before caches load → first requests fail

A naive `/health` that checks **everything**:
- DB has a 2-second blip → **every** instance fails health → orchestrator restarts **all** of them → full outage caused by the health check itself

---

## 2. Three kinds of probes

| Probe | Question | On failure | Should check |
|---|---|---|---|
| **Liveness** | is the process stuck/broken beyond repair? | **restart** the container | process responsive, event loop not frozen. **NOT** dependencies |
| **Readiness** | should this instance receive traffic **now**? | **remove from LB** (no restart) | started up, not draining, critical deps reachable, not overloaded |
| **Startup** | has the app finished booting? | keep waiting, then restart if exceeded | init complete (migrations, cache warm-up) |

Plus a **deep health / status** endpoint for humans and dashboards: per-dependency status, versions, latency — not used for automated restarts.

### Why liveness must not check dependencies

```text
DB slow → liveness fails on all 10 pods → k8s restarts all 10 →
cold starts + reconnect storm hits the struggling DB → longer outage
```
Restarting your service doesn't fix the database. Liveness = "restarting **me** would help".

---

## 3. Kubernetes example

```yaml
startupProbe:
  httpGet: { path: /health/startup, port: 3000 }
  periodSeconds: 5
  failureThreshold: 30        # up to 150 s to boot
livenessProbe:
  httpGet: { path: /health/live, port: 3000 }
  periodSeconds: 10
  timeoutSeconds: 2
  failureThreshold: 3         # 30 s of failure → restart
readinessProbe:
  httpGet: { path: /health/ready, port: 3000 }
  periodSeconds: 5
  timeoutSeconds: 2
  failureThreshold: 2
  successThreshold: 1
```

Docker Compose has one `healthcheck` (closer to readiness); Docker restarts only with orchestrators/`autoheal`.

---

## 4. Node.js sketch

```ts
import { monitorEventLoopDelay } from "node:perf_hooks";

const state = { started: false, draining: false };
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

async function check(name: string, fn: () => Promise<unknown>, timeoutMs = 500) {
  const t = performance.now();
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
    return { name, ok: true, ms: Math.round(performance.now() - t) };
  } catch (e) {
    return { name, ok: false, ms: Math.round(performance.now() - t), error: (e as Error).message };
  }
}

// liveness: cheap, no dependencies
app.get("/health/live", (_req, res) => res.status(200).json({ status: "alive" }));

// startup
app.get("/health/startup", (_req, res) => res.status(state.started ? 200 : 503).end());

// readiness: can I serve traffic?
app.get("/health/ready", async (_req, res) => {
  if (!state.started || state.draining) return res.status(503).json({ status: "not_ready", draining: state.draining });
  const lagMs = loop.mean / 1e6;
  const checks = await Promise.all([
    check("postgres", () => pool.query("SELECT 1")),            // critical dependency
  ]);
  const ok = checks.every((c) => c.ok) && lagMs < 500;
  res.status(ok ? 200 : 503).json({ status: ok ? "ready" : "not_ready", eventLoopLagMs: Math.round(lagMs), checks });
});

// deep status: for humans/dashboards, includes non-critical deps
app.get("/health", async (_req, res) => {
  const checks = await Promise.all([
    check("postgres", () => pool.query("SELECT 1")),
    check("redis", () => redis.ping()),
    check("payments-api", () => fetch("http://payments/health/live").then((r) => { if (!r.ok) throw new Error(String(r.status)); })),
  ]);
  res.json({ version: process.env.GIT_SHA, uptimeS: Math.round(process.uptime()), checks });
});

process.on("SIGTERM", () => {
  state.draining = true;                       // readiness → 503
  setTimeout(() => server.close(() => process.exit(0)), 5000); // let LB notice, then stop
});
```

---

## 5. Design rules

1. **Liveness is cheap and local.** No DB, no network. If the event loop can answer, it's alive. (Optionally fail if event-loop lag is extreme for a long time — a true hang.)
2. **Readiness checks only critical dependencies** — ones without which *every* request fails. A cache (Redis) with DB fallback is **not** critical.
3. **Timeouts on every check** — a hanging DB call must not hang the probe beyond the probe timeout.
4. **Cache dependency results** for a second or two when probes are frequent and instances many (100 pods × 1 probe/s = 100 DB pings/s).
5. **Thresholds** — require N consecutive failures (avoid flapping on a blip).
6. **Don't cascade** — checking downstream services' health in your readiness means one failing leaf service marks the whole call graph unready. Prefer circuit breakers + degraded mode (guide 18).
7. **Fail readiness when draining** — first step of graceful shutdown.
8. **Fail readiness when overloaded** (optional) — shed load by temporarily leaving the pool; careful: if all instances do it, you get zero capacity.
9. **Secure the deep endpoint** — it leaks versions and topology; liveness/readiness can be internal-only.

---

## 6. Health check status codes and formats

- `200` healthy / ready, `503` not ready
- A common JSON format (IETF draft "health+json"):
```json
{ "status": "pass", "version": "1.4.2", "checks": { "postgres:connection": [{ "status": "pass", "observedValue": 3, "observedUnit": "ms" }] } }
```

---

## 7. Who consumes health checks

| Consumer | Uses | Action |
|---|---|---|
| Kubernetes kubelet | liveness / readiness / startup | restart / remove from Service endpoints |
| Load balancer (Nginx, ALB) | readiness-like | stop routing |
| Service registry (Consul) | readiness | deregister |
| Docker healthcheck | single check | mark unhealthy (Swarm replaces) |
| Uptime monitoring (external) | public endpoint | alert humans |
| Dashboards | deep health | diagnostics |

---

## 8. Failure modes

| Mistake | Outcome |
|---|---|
| liveness checks DB | DB blip → restart storm → longer outage |
| no readiness | traffic during startup/shutdown → errors on every deploy |
| health always 200 | dead instances keep receiving traffic |
| probe timeout < check duration | false failures under load |
| readiness depends on downstream service health | cascading unavailability |
| expensive health query | health checks become significant load |
| health endpoint behind auth/rate-limit | probes fail → restarts |

---

## 9. Interview questions

1. **Liveness vs readiness?** — Liveness: restart if broken; readiness: route traffic only if able to serve.
2. **Should liveness check the database?** — No — restarting the app doesn't fix the DB and causes restart storms.
3. **What should readiness check?** — Startup complete, not draining, critical dependencies reachable, maybe overload signals.
4. **How do health checks enable zero-downtime deploys?** — New pods receive traffic only when ready; old pods fail readiness and drain before exit.
5. **What is a startup probe for?** — Slow-booting apps; prevents liveness killing them during init.
6. **How do you avoid health checks causing cascading failures?** — Don't check downstream service health in readiness; use circuit breakers and degraded modes.

**Prev:** [16 — Service Discovery](16-service-discovery.md) · **Next:** [18 — Circuit Breaker](18-circuit-breaker.md)
