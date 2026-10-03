# System Design 101 with Node.js + TypeScript

A hands-on system design course where **every concept is a standalone lab** you can run, benchmark, break, and fix.

```bash
cd 00-basics
docker compose up --build
```

No slides. You'll measure latency percentiles, kill containers, partition replicas and watch what happens, then explain it in an interview.

---

## How this course works

Every lab follows the same teaching loop:

```text
Problem → Simple solution → Bottleneck → Scaling → Failure → Trade-offs
```

and the same hands-on loop:

```text
Understand the concept → See the architecture → Run the simplest version
→ Benchmark it → Break it on purpose → Fix it → Production considerations → Interview questions
```

## Labs

| # | Lab | You'll learn | Status |
|---|---|---|---|
| 00 | [basics](00-basics/) | latency, throughput, bandwidth, availability, reliability, fault tolerance, scaling, CAP | ✅ |
| 01 | [load-balancer](01-load-balancer/) | Nginx + a TypeScript LB, 5 strategies, active vs passive health checks, draining | ✅ |
| 02 | caching | cache-aside, write-through, TTL, invalidation, stampede | ⏳ |
| 03 | redis | data structures, counters, sessions, distributed locks | ⏳ |
| 04 | database-index | B-tree, composite indexes, EXPLAIN ANALYZE | ⏳ |
| 05 | database-replication | primary/replica, read splitting, replication lag, failover | ⏳ |
| 06 | database-sharding | shard keys, consistent hashing, hot partitions | ⏳ |
| 07 | rate-limiting | fixed window, sliding window, token bucket | ⏳ |
| 08 | message-queue | RabbitMQ, ack, retry, DLQ, backpressure | ⏳ |
| 09 | kafka | topics, partitions, offsets, consumer groups | ⏳ |
| 10 | websocket | realtime chat, rooms, scaling WebSockets | ⏳ |
| 11 | pub-sub | Redis Pub/Sub across API instances | ⏳ |
| 12 | search | inverted index, relevance, autocomplete | ⏳ |
| 13 | cdn | edge vs origin, cache hit/miss, invalidation | ⏳ |
| 14 | object-storage | MinIO, presigned URLs, multipart upload | ⏳ |
| 15 | api-gateway | routing, auth, rate limiting at the edge | ⏳ |
| 16 | service-discovery | DNS, registries, health-based routing | ⏳ |
| 17 | health-check | liveness vs readiness vs health | ⏳ |
| 18 | circuit-breaker | CLOSED → OPEN → HALF_OPEN | ⏳ |
| 19 | retry-timeout | timeouts, exponential backoff, jitter | ⏳ |
| 20 | idempotency | Idempotency-Key for payments | ⏳ |
| 21 | observability | structured logs, Prometheus, Grafana, correlation IDs | ⏳ |
| 22 | horizontal-scaling | stateless services, shared sessions | ⏳ |
| 23 | microservices | service boundaries, gateway, per-service deploys | ⏳ |
| 24 | final-project | scalable e-commerce backend using everything | ⏳ |

See [ROADMAP.md](ROADMAP.md) for the learning phases and how labs build on each other.

## Every lab has the same layout

```text
NN-lab-name/
├── README.md            # start here: goal, concept, how to run, experiments summary
├── CONCEPTS.md          # deep explanation with Node.js examples
├── ARCHITECTURE.md      # diagrams + explanation of every component
├── EXPERIMENTS.md       # step-by-step experiments with exact commands and real results
├── INTERVIEW.md         # 15+ questions with answers (beginner → advanced)
├── TROUBLESHOOTING.md   # common problems + exact diagnosis commands
├── docs/
│   ├── architecture.md  # code structure
│   ├── request-flow.md  # one request, hop by hop, with failure points
│   └── trade-offs.md    # advantages, disadvantages, alternatives, limits
├── src/                 # TypeScript (strict), Express
├── tests/               # vitest
├── Dockerfile
├── docker-compose.yml
└── package.json, tsconfig.json, .env.example
```

Labs are **independent**: each has its own `package.json`, `node_modules` and `docker-compose.yml`. You can start anywhere, though the order is designed to build intuition step by step.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 22+ | runtime |
| npm | 10+ | packages |
| Docker Desktop | Compose v2+ | infrastructure (Redis, Postgres, Kafka, Nginx...) |
| curl | any | manual requests |
| Git Bash (Windows) | any | the commands in the docs are bash |

Load testing tools need no install: `npx autocannon` comes with each lab, and k6 runs via `docker run grafana/k6`.

## Common commands (every lab)

```bash
npm install              # install dependencies
npm run dev              # run locally with auto-reload (tsx watch)
npm run build            # type-check + compile TypeScript to dist/
npm test                 # run tests (vitest)
docker compose up --build   # build images and start all containers
docker compose down         # stop and remove containers
docker compose down -v      # ... and delete volumes (database data!)
```

## Tech stack

Node.js 22 · TypeScript 7 (strict) · Express 5 · Vitest · Docker Compose · and per lab: Nginx, Redis, PostgreSQL, RabbitMQ, Kafka, OpenSearch, MinIO, Prometheus, Grafana.

Code style: deliberately **simple**: `routes → controllers → services`, plain constructor injection, no DI frameworks or heavy patterns unless a lab is *about* that pattern. The point is learning system design, not framework ceremony.

## Reference

- [GLOSSARY.md](GLOSSARY.md): every term in plain language, with Node.js snippets
- [SYSTEM-DESIGN-CHECKLIST.md](SYSTEM-DESIGN-CHECKLIST.md): the questions to ask when designing any system (and in every interview)
- [ROADMAP.md](ROADMAP.md): phases and dependencies between labs
