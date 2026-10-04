# 23 — Microservices

> Microservices solve **organisational** scaling problems by introducing **distributed systems** problems. Make sure you have the first before accepting the second.

---

## 1. Monolith first

A **monolith** is one deployable unit containing all features.

```text
┌──────────────── monolith ────────────────┐
│ users │ catalog │ orders │ payments │ ... │ ──▶ one database
└──────────────────────────────────────────┘
```

Monolith strengths (often underrated):
- simple to develop, test, debug, and deploy
- function calls instead of network calls (fast, reliable)
- ACID transactions across features
- one place for logs, one repo, one pipeline

Monoliths struggle when:
- 50+ engineers step on each other; deploys need coordination
- one part needs very different scaling (image processing vs CRUD)
- a bug in one module crashes everything
- build/test cycle takes an hour
- tech choices are locked

**Modular monolith** — a monolith with strict internal module boundaries (separate folders/packages, no reaching into another module's tables, interfaces between modules). Gets most of the design benefit with none of the network cost, and makes a later split easy. Often the right answer.

---

## 2. What microservices are

Small, independently deployable services, each owning a **business capability** and its **own data**, communicating over the network.

```text
             ┌──▶ user-service    ──▶ users DB
client ─▶ GW ┼──▶ catalog-service ──▶ catalog DB (+ search index)
             ├──▶ order-service   ──▶ orders DB ──events──▶ Kafka
             └──▶ payment-service ──▶ payments DB
```

Key properties:
- **Independent deployment** — ship order-service without touching others
- **Database per service** — no shared tables; other services use the API/events
- **Team ownership** — "you build it, you run it" (Conway's Law: system mirrors org structure)
- **Technology freedom** (use wisely)
- **Fault isolation** (only if you design for it: timeouts, breakers, async)

---

## 3. Finding service boundaries

Bad boundaries are the #1 microservices failure: a "distributed monolith" where every change touches 5 services and they must deploy together.

Guidelines:
- Split by **business capability / bounded context** (DDD), not by technical layer (no "database-service", "validation-service")
- High **cohesion** inside, low **coupling** between
- A service should be able to fulfil most of its requests **without synchronously calling others**
- Data that changes together lives together
- Align with team boundaries

```text
✅ ordering, catalog, payments, shipping, identity, notifications
❌ "CRUD service per table", "utils-service", entity services that every flow needs
```

Signals of wrong boundaries: chatty calls, shared database, lockstep deploys, distributed transactions everywhere.

---

## 4. Communication

### Synchronous (request/response)
REST/HTTP+JSON or **gRPC** (HTTP/2, Protobuf, typed contracts, streaming — great for internal calls).

✅ simple, immediate answer
❌ temporal coupling: if payment is down, order is down; latency adds up; availability multiplies down (guide 00)

### Asynchronous (events / messages)
Kafka / RabbitMQ / SNS+SQS (guides 08, 09, 11).

✅ decoupled in time, resilient, easy to add consumers
❌ eventual consistency, harder debugging, duplicates/ordering to handle

**Rule of thumb:** sync for queries that need an answer now; async for propagating state changes ("OrderPlaced") and long workflows.

### Commands vs events
- **Command**: "ChargePayment" — directed at one service, expects it to act
- **Event**: "OrderPlaced" — a fact; publisher doesn't care who listens

---

## 5. Data management

### Database per service
Each service owns its schema. Others **never** query it directly.

Problems this creates and their solutions:

| Problem | Solution |
|---|---|
| Queries across services ("orders with customer names") | API composition at gateway/BFF; or **CQRS read model** built from events |
| Need another service's data often | keep a **local replica** of the fields you need, updated by events |
| Atomic changes across services | **Saga** |
| Publish event + write DB atomically | **Transactional outbox** (guide 08) |

### Sagas — distributed transactions without 2PC

A saga is a sequence of local transactions; if a step fails, run **compensating** actions for completed steps.

```text
Order saga (orchestrated)
1. order-service:     create order (PENDING)
2. inventory-service: reserve stock          ── fail → cancel order
3. payment-service:   charge card            ── fail → release stock, cancel order
4. order-service:     mark CONFIRMED
```

| Style | How | Pros | Cons |
|---|---|---|---|
| **Choreography** | services react to each other's events | decoupled, simple for short flows | flow is implicit, hard to follow, cyclic deps |
| **Orchestration** | a coordinator tells each service what to do | explicit flow, easier monitoring | coordinator is extra component |

Tools: Temporal, AWS Step Functions, Camunda — or a hand-written state machine.

Compensations aren't rollbacks (you can't "unsend" an email) — design for semantic undo (refund, cancellation notice). Every step must be **idempotent** (guide 20).

---

## 6. Cross-cutting infrastructure you now need

| Need | Guide |
|---|---|
| API gateway / BFF | 15 |
| Service discovery | 16 |
| Health checks | 17 |
| Timeouts, retries, circuit breakers, bulkheads | 18, 19 |
| Idempotency | 20 |
| Centralized logs, metrics, distributed tracing | 21 |
| Message broker | 08, 09 |
| CI/CD per service, containers, orchestration (k8s) | — |
| Contract testing (Pact), API versioning | — |
| Secrets management, mTLS / zero-trust between services | — |

This is the **microservices tax**. Without it, microservices are worse than a monolith.

---

## 7. Node.js sketch — service skeleton & typed internal client

```text
services/
  order-service/
    src/{app.ts, routes/, domain/, infra/db.ts, infra/events.ts}
    Dockerfile
    package.json
  payment-service/ ...
packages/
  contracts/      # shared event & API types (versioned) — not shared business logic
```

```ts
// packages/contracts/src/events.ts
export type OrderPlacedV1 = {
  type: "OrderPlaced"; version: 1; eventId: string; occurredAt: string;
  orderId: string; userId: string; totalCents: number; items: { sku: string; qty: number }[];
};

// order-service: calling payment-service with resilience
const paymentBreaker = new CircuitBreaker("payment");

export async function charge(orderId: string, amountCents: number, requestId: string) {
  return paymentBreaker.call((signal) =>
    withRetry(async () => fetchJson(`${await discovery.resolve("payment-service")}/charges`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "idempotency-key": `charge-${orderId}`, "x-request-id": requestId },
      body: JSON.stringify({ orderId, amountCents }),
    }), { retries: 2, baseMs: 100, capMs: 1000 }));
}
```

Share **contracts** (types/schemas), never domain logic or DB models, across services — shared libraries become a coupling point that forces lockstep upgrades.

---

## 8. Testing

| Level | What |
|---|---|
| Unit | domain logic per service |
| Integration | service + its own DB/broker (Testcontainers) |
| **Contract** | consumer-driven contracts (Pact) verify provider still satisfies consumers — replaces most E2E |
| E2E | few critical journeys only — slow and flaky across many services |

---

## 9. Migrating from a monolith — Strangler Fig

```text
1. put a gateway/proxy in front of the monolith
2. pick one well-bounded capability (e.g. notifications)
3. build it as a service; route its traffic via gateway
4. migrate its data; monolith calls the new service or consumes events
5. delete the code from the monolith; repeat
```
Never big-bang rewrite.

---

## 10. Anti-patterns

| Anti-pattern | Symptom |
|---|---|
| **Distributed monolith** | services must deploy together |
| **Shared database** | schema change breaks 4 services |
| **Nano-services** | more services than engineers; every feature = 6 PRs |
| **Chatty sync chains** | A→B→C→D; latency and availability compound |
| **No observability** | can't debug anything |
| **Microservices for a 3-person startup** | infrastructure work eats product time |

---

## 11. Trade-offs

| Gain | Cost |
|---|---|
| independent deploys and team autonomy | network latency, partial failures |
| scale components independently | eventual consistency, sagas |
| fault isolation (if designed) | operational complexity (CI/CD, k8s, tracing) |
| tech flexibility | harder testing and debugging |
| smaller codebases | data duplication, contract versioning |

---

## 12. Interview questions

1. **Monolith vs microservices — when each?** — Monolith (modular) for small teams/early products; microservices when org size, independent deploys, and differing scaling needs justify the operational cost.
2. **How do you decide service boundaries?** — Business capabilities/bounded contexts, high cohesion, data ownership, team alignment.
3. **Why database per service?** — Independent evolution and deploy; avoids hidden coupling. Cost: cross-service queries and consistency.
4. **How do you do a transaction across services?** — Saga with compensations (choreography or orchestration), idempotent steps, outbox for events.
5. **Sync vs async communication?** — Immediate answers vs temporal decoupling and resilience.
6. **What is a distributed monolith?** — Microservices that are tightly coupled and must change/deploy together — worst of both worlds.
7. **How would you migrate a monolith?** — Strangler fig: gateway in front, extract capabilities one at a time.

**Prev:** [22 — Horizontal Scaling](22-horizontal-scaling.md) · **Next:** [24 — Final Project](24-final-project.md)
