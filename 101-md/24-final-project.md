# 24 — Final Project: Scalable E-commerce Backend

> Every previous guide was one tool. This one is the whole toolbox: how the pieces fit, why each exists, and what happens when each fails.

---

## 1. Requirements

### Functional
- Users register/login
- Browse and search products
- Cart and checkout
- Pay for orders
- Receive email confirmation
- View order history

### Non-functional (example targets)
| Requirement | Target |
|---|---|
| Users | 1 M DAU, 50k concurrent at peak |
| Read traffic | ~5,000 RPS peak (browse/search) |
| Write traffic | ~200 orders/s peak (flash sale) |
| Latency | p99 < 300 ms for reads, < 1 s for checkout |
| Availability | 99.9% for browse, 99.95% for checkout |
| Correctness | **never double-charge, never oversell** |

### Back-of-envelope (guide 00)
```text
orders/day      = 1M DAU × 5% buy = 50k orders/day  (flash peak 200/s)
product reads   = 1M × 30 views = 30M/day ≈ 350 RPS avg, ×10 peak ≈ 3.5k RPS
catalog size    = 1M products × 2 KB = 2 GB  → fits in RAM/cache easily
order storage   = 50k × 5 KB × 365 ≈ 90 GB/year → one PostgreSQL primary is fine for years
images          = 1M × 5 variants × 200 KB = 1 TB → object storage + CDN
```
Conclusion: reads dominate → **cache + CDN + replicas**. Writes are modest → **no sharding needed yet**. Correctness of checkout is the hard part.

---

## 2. Architecture

```text
                         ┌─────────────── CDN (images, static, public product pages) ─────┐
                         │                                                                 │
 client ──HTTPS──▶ LB ──▶ API GATEWAY (auth, rate limit, routing, request-id, tracing)
                              │
        ┌───────────┬─────────┼──────────────┬───────────────┐
        ▼           ▼         ▼              ▼               ▼
   user-svc    catalog-svc  cart-svc     order-svc      payment-svc
      │          │    │       │             │   │            │
   users DB   catalog DB  Redis(carts)   orders DB outbox  payments DB ──▶ payment provider
              (+replica)                      │
              Redis cache                     ▼
              search index ◀── indexer ◀── KAFKA (OrderPlaced, PaymentSucceeded, StockReserved, ...)
                                              │
                                    ┌─────────┼──────────┐
                                    ▼         ▼          ▼
                             notification  inventory   analytics
                               worker       consumer    consumer
                                 │
                               email provider

 cross-cutting: service discovery (k8s DNS) · health checks · Prometheus/Grafana · Loki · Tempo/Jaeger
```

Start as a **modular monolith** with these modules if the team is small (guide 23); the boundaries above are where you'd split later.

---

## 3. Component by component — which guide, and why

| Component | Concept | Why here |
|---|---|---|
| CDN | [13](13-cdn.md) | product images & static assets; public catalog pages with short TTL |
| Load balancer | [01](01-load-balancer.md) | spread traffic, survive instance loss |
| API gateway | [15](15-api-gateway.md) | JWT validation, per-user/IP limits, routing, request IDs |
| Rate limiting | [07](07-rate-limiting.md) | protect login (brute force) and checkout (bots in flash sales) |
| Stateless services | [22](22-horizontal-scaling.md) | autoscale on RPS/latency; sessions as JWT + refresh tokens |
| Redis | [03](03-redis.md) | cart storage, product cache, rate-limit counters, locks |
| Caching | [02](02-caching.md) | cache-aside for product details; stampede protection for hot products |
| PostgreSQL + indexes | [04](04-database-index.md) | orders `(user_id, created_at)` index for history; products by category |
| Read replicas | [05](05-database-replication.md) | catalog reads; order history reads (with read-your-writes after checkout) |
| Sharding | [06](06-database-sharding.md) | **not yet** — documented as the plan if orders grow 100× (shard by `user_id`) |
| Search | [12](12-search.md) | product full-text, facets, autocomplete; fed by CDC/events |
| Object storage | [14](14-object-storage.md) | product images via presigned upload (admin), variants by worker |
| Kafka | [09](09-kafka.md) | domain events keyed by `orderId` (ordering per order), replay for new consumers |
| Message queue / workers | [08](08-message-queue.md) | emails, image processing; retries + DLQ |
| Pub/Sub | [11](11-pub-sub.md) | cache invalidation across instances; live order status to WebSocket servers |
| WebSocket / SSE | [10](10-websocket.md) | live order status ("payment confirmed", "shipped") |
| Service discovery | [16](16-service-discovery.md) | k8s Services / Compose DNS |
| Health checks | [17](17-health-check.md) | liveness (process), readiness (DB reachable, not draining) |
| Circuit breaker | [18](18-circuit-breaker.md) | around payment provider, search, recommendations |
| Retry + timeout | [19](19-retry-timeout.md) | every outbound call has a timeout; retries with jitter on idempotent calls |
| Idempotency | [20](20-idempotency.md) | `Idempotency-Key` on checkout and payment; idempotent consumers |
| Observability | [21](21-observability.md) | RED per route, checkout funnel metrics, traces across services |
| Microservices | [23](23-microservices.md) | saga for checkout, outbox, database per service |

---

## 4. Key flows

### 4.1 Browse a product (read path — make it fast)

```text
client → CDN (HTML/JSON cached 60 s?) → hit: done
       → miss → gateway → catalog-svc → Redis product:{id}
                                         ├ hit → return
                                         └ miss → single-flight → PG replica → SET with TTL+jitter
```
- Cache-aside, TTL 5 min + jitter, delete on admin update + pub/sub invalidation of L1 caches
- Stock count shown is **approximate** (cached) — the real check happens at checkout

### 4.2 Checkout (write path — make it correct)

Orchestrated **saga** inside order-svc:

```text
POST /checkout  Idempotency-Key: K
 1. gateway: auth, rate limit (5 checkouts/min/user)
 2. order-svc: idempotency claim on K (replay if seen)
 3. order-svc: TX { insert order PENDING; insert outbox "OrderPlaced" }   → 202 Accepted {orderId}
 4. inventory: reserve stock atomically
        UPDATE stock SET reserved = reserved + :q
        WHERE sku = :sku AND available - reserved >= :q        -- no oversell
        fail → OrderRejected (out of stock)
 5. payment-svc: charge provider with idempotency key "order-{id}"
        (timeout 3 s, retry ×2 with jitter, circuit breaker)
        fail → release stock (compensation), order FAILED
 6. order-svc: order CONFIRMED → outbox "OrderConfirmed"
 7. notification worker: send email (idempotent by eventId)
 8. client sees status via SSE/WebSocket or polling GET /orders/{id}
```

Why 202 + async? Payment providers can take seconds; holding the HTTP request is fragile. The client tracks status.

### Correctness guarantees and how they're achieved

| Guarantee | Mechanism |
|---|---|
| No double order from double-click/retry | Idempotency-Key + unique constraint |
| No double charge | provider idempotency key = `order-{id}`; payment row unique per order |
| No oversell | conditional atomic UPDATE (or Redis Lua decrement for flash sales) |
| No lost events | transactional outbox → Kafka (`acks=all`) |
| No duplicate emails | consumer dedupe by `eventId` |
| Recover from crash mid-saga | saga state persisted; resumes from last step; all steps idempotent |

### 4.3 Flash sale (1,000 units, 100k users at 10:00)
- Pre-warm caches; pre-scale services (scheduled autoscaling)
- Gateway rate limits + bot protection
- Stock counter in **Redis** with atomic Lua decrement (`if stock >= q then DECRBY`) — fast gate; DB is reconciled asynchronously via queue
- Queue checkouts (virtual waiting room) to level load on payment/DB
- Sold-out state cached and served from CDN immediately

---

## 5. Failure scenarios (practice these out loud)

| Failure | Impact | Mitigation |
|---|---|---|
| one API instance dies | in-flight requests fail | LB health checks, retries (idempotent), N+1 instances |
| Redis down | cache misses, carts unavailable | fall back to DB with single-flight + rate limit; Redis Sentinel; carts degrade |
| PG primary dies | writes fail ~30 s | Patroni failover; checkout returns 503 + retry; reads from replicas continue |
| replica lag | user doesn't see new order | read order history from primary right after checkout |
| payment provider slow/down | checkouts stuck | timeout + breaker → order stays PENDING, retried by saga later; user informed |
| Kafka down | events not published | outbox accumulates in DB; relay catches up later — checkout still works |
| email provider down | no confirmation emails | queue retries with backoff, DLQ, alert |
| search cluster down | search fails | breaker → fallback to simple DB category browse |
| bad deploy | errors spike | canary + automated rollback on error-rate SLO |
| traffic 10× spike | latency up | CDN absorbs reads, autoscale, load shedding, rate limits |
| poison event | consumer stuck | catch → DLQ topic → continue |

---

## 6. Data model sketch

```sql
-- order-svc
CREATE TABLE orders (
  id uuid PRIMARY KEY, user_id bigint NOT NULL, status text NOT NULL,
  total_cents bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), version int NOT NULL DEFAULT 0
);
CREATE INDEX ON orders (user_id, created_at DESC);
CREATE TABLE order_items (order_id uuid REFERENCES orders, sku text, qty int, price_cents bigint, PRIMARY KEY (order_id, sku));
CREATE TABLE outbox (id uuid PRIMARY KEY, topic text, key text, payload jsonb, created_at timestamptz DEFAULT now(), sent_at timestamptz);
CREATE TABLE idempotency_keys (user_id bigint, key text, request_hash text, status text, response_code int, response_body jsonb,
  created_at timestamptz DEFAULT now(), PRIMARY KEY (user_id, key));

-- inventory
CREATE TABLE stock (sku text PRIMARY KEY, available int NOT NULL CHECK (available >= 0), reserved int NOT NULL DEFAULT 0);

-- payment-svc
CREATE TABLE payments (id uuid PRIMARY KEY, order_id uuid UNIQUE NOT NULL, status text, provider_ref text, amount_cents bigint);
```

---

## 7. Observability plan

- **Business metrics**: checkouts started/completed/failed, payment success rate, revenue/min, stock-outs
- **RED** per service & route; **USE** for PG pool, Redis, Kafka consumer lag, event-loop lag
- **Traces**: gateway → order → inventory → payment → provider
- **SLOs**: checkout success ≥ 99.5%, browse p99 < 300 ms → burn-rate alerts
- **Runbooks** for each failure scenario in section 5

---

## 8. Evolution path

```text
v1  modular monolith + PG + Redis + CDN (+ worker for emails)        → handles far more than you think
v2  extract notification & search; Kafka + outbox; read replicas
v3  extract payments & inventory; orchestrated saga; per-service DBs
v4  shard orders by user_id; multi-region read; active-passive DR
```
Scale **because measurements demand it**, not because the diagram looks impressive.

---

## 9. How to present this in an interview (45 minutes)

1. **Clarify requirements** (5 min) — functional, scale, SLOs, consistency needs
2. **Estimate** (5 min) — RPS, storage, read/write ratio → drives every decision
3. **High-level design** (10 min) — boxes and arrows from section 2
4. **Deep dive** (15 min) — checkout saga, idempotency, no-oversell, caching strategy
5. **Failures & bottlenecks** (7 min) — walk section 5
6. **Trade-offs & evolution** (3 min) — what you'd do at 10× / 100×

Say the trade-off out loud every time you pick a component: *"I'm choosing async checkout with 202 because payment latency is unpredictable; the cost is the client must poll or subscribe for status."*

---

## 10. Self-check questions

1. Walk through checkout when the payment provider times out after charging the card. *(idempotent retry with same key → provider returns the original charge)*
2. How do you guarantee no overselling with 10 instances? *(atomic conditional update / Redis Lua; never read-then-write in app code)*
3. Redis is down during peak — what happens to each flow?
4. The order was created but the email never arrived — where do you look? *(trace by orderId: outbox → Kafka lag → notification worker logs → DLQ)*
5. Why didn't you shard? When would you, and by what key?
6. How do you deploy order-svc mid-flash-sale safely?
7. What's the single biggest risk in this design, and how would you reduce it?

**Prev:** [23 — Microservices](23-microservices.md) · **Index:** [README](README.md)
