# 22 — Horizontal Scaling

> To scale out, every instance must be interchangeable. The trick is not adding servers — it's removing state from them.

---

## 1. The problem

You put 3 API instances behind a load balancer (guide 01). Suddenly:

- users get logged out randomly (session was in instance A's memory, request went to B)
- uploaded files "disappear" (saved to A's local disk)
- rate limits are 3× too generous (each instance counts separately)
- the cron job sends every email 3 times (runs on every instance)
- WebSocket messages reach only some users
- in-memory caches show different data on different instances

All of these are **state stored on the instance**. Horizontal scaling requires **stateless** application servers.

---

## 2. Stateless vs stateful

**Stateless service:** any instance can handle any request because everything needed is in the request itself or in shared external stores.

```text
            ┌──▶ API 1 ─┐
client ─▶ LB ┼──▶ API 2 ─┼──▶ shared state: PostgreSQL, Redis, S3, Kafka
            └──▶ API 3 ─┘
```

| State | Move it to |
|---|---|
| Sessions | Redis (session store) or signed tokens (JWT) |
| Uploaded files | object storage (guide 14) |
| Cache | Redis (shared) or accept per-instance L1 with short TTL |
| Rate limit counters | Redis (guide 07) |
| Locks | Redis / DB advisory locks (guide 03) |
| Scheduled jobs | single scheduler / leader election / queue (BullMQ repeatable jobs) |
| WebSocket fan-out | pub/sub backplane (guide 11) |
| Config | env vars / config service, not files edited on a box |
| Background work | message queue + workers (guide 08) |

Benefits of statelessness: add/remove instances freely, instances can crash without data loss, rolling deploys, autoscaling, no sticky sessions.

---

## 3. Sessions: Redis vs JWT

### Server-side sessions in Redis
```ts
import session from "express-session";
import { RedisStore } from "connect-redis";

app.use(session({
  store: new RedisStore({ client: redis, prefix: "sess:" }),
  secret: process.env.SESSION_SECRET!,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: true, sameSite: "lax", maxAge: 86_400_000 },
}));
```
✅ revoke instantly (delete key), small cookie, server controls data
❌ Redis lookup per request; Redis must be HA

### Stateless tokens (JWT)
Signed token contains claims; any instance verifies the signature, no lookup.
✅ no shared store, works across services
❌ **can't revoke before expiry** (use short-lived access tokens ~15 min + refresh tokens stored server-side, or a denylist), token size, key rotation

Common hybrid: short JWT access token + refresh token in DB/Redis.

---

## 4. Scaling Node.js on one machine

One Node process ≈ one core for JavaScript (guide 00).

| Option | How |
|---|---|
| `cluster` module | primary forks N workers sharing a port |
| PM2 cluster mode | `pm2 start app.js -i max` |
| Multiple containers | `docker compose up --scale api=4` behind Nginx — same model as multi-machine (preferred in containers) |
| `worker_threads` | offload CPU-heavy tasks inside a process (not for scaling HTTP) |

Inside Kubernetes, prefer **1 process per container** and scale pods; let the orchestrator do the job of `cluster`.

---

## 5. Autoscaling

Add/remove instances automatically based on signals.

| Signal | Good for |
|---|---|
| CPU % | CPU-bound services |
| RPS per instance | request-driven APIs |
| Latency / event-loop lag | Node services (CPU% can be misleading for I/O-bound apps) |
| Queue depth / consumer lag | workers (KEDA) |
| Schedule | predictable peaks (9 a.m., Black Friday pre-scaling) |

Considerations:
- **Startup time** — scaling takes 30 s–minutes; keep images small, boot fast, use readiness probes
- **Cooldown / stabilization** — avoid flapping
- **Min replicas ≥ 2** for availability; spread across zones
- **Max replicas** — protect downstream (DB connections!)

---

## 6. The next bottleneck: shared state

Scaling the stateless tier moves pressure onto shared components.

```text
10 API instances × pool size 20 = 200 PostgreSQL connections
50 API instances × pool size 20 = 1,000 connections → PG falls over (each connection ≈ a process, ~10 MB)
```

Fixes:
- connection pooler (**PgBouncer** in transaction mode)
- smaller per-instance pools (Little's Law: size from throughput × query time)
- caching (guide 02), read replicas (guide 05), then sharding (guide 06)
- Redis cluster for Redis load

Rule: **the stateless tier scales linearly; the data tier doesn't.** Design the data tier for the scale you want.

---

## 7. Graceful shutdown and deploys

Instances come and go constantly — they must start and stop cleanly.

```ts
let shuttingDown = false;
app.get("/health/ready", (_req, res) => res.status(shuttingDown ? 503 : 200).end());

process.on("SIGTERM", async () => {
  shuttingDown = true;                         // 1. leave the LB pool
  await new Promise((r) => setTimeout(r, 5000));  // 2. wait for LB to notice
  server.close(async () => {                   // 3. finish in-flight requests
    await Promise.allSettled([pool.end(), redis.quit(), consumer.disconnect()]);  // 4. release resources
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 25_000).unref(); // 5. hard deadline
});
```

Deploy strategies:
- **Rolling** — replace instances a few at a time (needs backward-compatible changes)
- **Blue/green** — full new set, switch traffic, instant rollback
- **Canary** — small % to new version, watch metrics, ramp up

**Backward compatibility**: during a rolling deploy, old and new versions run simultaneously → DB schema and API changes must be compatible with both (expand → migrate → contract).

---

## 8. The Twelve-Factor App (relevant factors)

- **Config** in environment, not code
- **Backing services** (DB, cache, queue) as attached resources via URLs
- **Processes** stateless, share-nothing
- **Disposability** — fast startup, graceful shutdown
- **Logs** as event streams to stdout
- **Concurrency** — scale out via the process model

---

## 9. Scheduled jobs with many instances

```text
❌ setInterval(sendDailyDigest, 24h) in the API → runs on every instance
```
Options:
- dedicated single scheduler process / k8s **CronJob**
- distributed lock: only the lock holder runs (`SET job:digest:2026-10-04 NX EX 3600`)
- job queue with repeatable jobs (BullMQ) — one job enqueued, one worker picks it up
- leader election (etcd/Consul/k8s Lease)

---

## 10. Failure modes

| Problem | Cause | Fix |
|---|---|---|
| random logouts | in-memory sessions | Redis sessions / JWT |
| duplicated cron work | job on every instance | lock / scheduler / queue |
| DB connection exhaustion | pools × instances | PgBouncer, smaller pools |
| inconsistent caches | per-instance caches | shared cache or pub/sub invalidation |
| errors during deploy | no draining / incompatible versions | graceful shutdown, readiness, expand-contract |
| autoscaling too slow | slow boot | faster startup, pre-scaling, headroom |
| shared store becomes SPOF | single Redis | Redis Sentinel/Cluster, fallbacks |

---

## 11. Interview questions

1. **What makes a service horizontally scalable?** — Statelessness: state externalised to shared stores; instances interchangeable.
2. **Where do you keep sessions?** — Redis session store or JWTs (short-lived + refresh tokens).
3. **JWT vs server sessions?** — No lookup and cross-service vs instant revocation and smaller cookies.
4. **You scaled API from 10 to 50 instances and the DB crashed — why?** — Connection count explosion; use pooler, size pools, cache, replicas.
5. **How do you run a cron job with many instances?** — Dedicated scheduler, distributed lock, or job queue.
6. **How do you deploy without downtime?** — Readiness + draining + rolling/blue-green/canary with backward-compatible changes.
7. **What metric would you autoscale a Node API on?** — RPS per instance or latency/event-loop lag (CPU for CPU-bound); queue lag for workers.

**Prev:** [21 — Observability](21-observability.md) · **Next:** [23 — Microservices](23-microservices.md)
