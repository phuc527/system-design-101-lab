# 11 — Pub/Sub (Publish / Subscribe)

> Publishers send events to a **topic/channel** without knowing who listens. Every subscriber gets its own copy.

---

## 1. The problem

- 3 API instances, each with WebSocket clients. A message arriving at instance A must reach clients on B and C.
- Admin updates a feature flag; every instance's in-memory cache must invalidate now.
- `OrderPlaced` must trigger email, analytics, and inventory — and next month, fraud detection — without editing the order service.

Point-to-point calls (`A` calls `B`, `C`, `D`) couple everything. **Pub/sub** inverts it:

```text
                         ┌──▶ subscriber 1 (email)
publisher ──▶ [ topic ] ─┼──▶ subscriber 2 (analytics)
                         └──▶ subscriber 3 (inventory)
```

---

## 2. Pub/sub vs work queue

| | Work queue (point-to-point) | Pub/sub (fan-out) |
|---|---|---|
| Each message delivered to | **one** consumer | **every** subscriber |
| Purpose | distribute work | broadcast events |
| Adding consumers | more throughput | more recipients |
| Example | resize image jobs | "user signed up" event |

Many systems combine them: fan out to N **groups/queues**, and within each group, messages are load-balanced (Kafka consumer groups, RabbitMQ fanout exchange → one queue per service with competing workers, SNS → SQS).

```text
event ─▶ fanout ─┬─▶ queue "email"     ─▶ worker, worker   (one of them handles it)
                 └─▶ queue "analytics" ─▶ worker
```

---

## 3. Delivery semantics — the big differentiator

| System | Durable? | If subscriber offline | Replay |
|---|---|---|---|
| **Redis Pub/Sub** | ❌ | message **lost** | ❌ |
| Redis Streams | ✅ | reads later (consumer groups) | ✅ |
| NATS core | ❌ | lost | ❌ |
| NATS JetStream | ✅ | stored | ✅ |
| RabbitMQ fanout (durable queues) | ✅ | queued | ❌ |
| Kafka | ✅ | reads from offset | ✅ |
| Google Pub/Sub, AWS SNS+SQS | ✅ | stored (retention) | limited |

**Redis Pub/Sub is fire-and-forget**: at-most-once, no persistence, no acks. Perfect for ephemeral signals (WebSocket broadcast, cache invalidation hints, live dashboards). Wrong for anything that must not be lost (payments, orders).

---

## 4. Redis Pub/Sub mechanics

```text
SUBSCRIBE chat:room1
PSUBSCRIBE chat:*          # pattern subscription
PUBLISH chat:room1 "hello" # returns number of receivers
```

- A connection in subscribe mode can't run normal commands → use a **separate connection** for subscribing
- Messages are pushed to each subscriber's output buffer; a slow subscriber's buffer grows → Redis disconnects it (`client-output-buffer-limit pubsub`)
- In Redis Cluster, classic `PUBLISH` is broadcast to **all nodes** (doesn't scale with cluster size) → use **sharded pub/sub** (`SPUBLISH`/`SSUBSCRIBE`, Redis 7+)

---

## 5. Node.js sketch — cross-instance WebSocket broadcast

```ts
import Redis from "ioredis";
import { WebSocketServer, WebSocket } from "ws";

const pub = new Redis(process.env.REDIS_URL!);
const sub = new Redis(process.env.REDIS_URL!);   // dedicated subscriber connection
const INSTANCE = process.env.HOSTNAME ?? crypto.randomUUID();

const wss = new WebSocketServer({ port: 8081 });
const localRooms = new Map<string, Set<WebSocket>>();

await sub.psubscribe("room:*");
sub.on("pmessage", (_pattern, channel, raw) => {
  const room = channel.slice("room:".length);
  for (const ws of localRooms.get(room) ?? []) {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);  // deliver to MY local clients
  }
});

wss.on("connection", (ws) => {
  ws.on("message", async (data) => {
    const { room, text, type } = JSON.parse(data.toString());
    if (type === "join") {
      if (!localRooms.has(room)) localRooms.set(room, new Set());
      localRooms.get(room)!.add(ws);
      return;
    }
    // don't send locally — publish; every instance (including me) delivers
    await pub.publish(`room:${room}`, JSON.stringify({ text, via: INSTANCE, at: Date.now() }));
  });
  ws.on("close", () => localRooms.forEach((set) => set.delete(ws)));
});
```

Optimisation: subscribe only to rooms that have local members (`SUBSCRIBE` on first join, `UNSUBSCRIBE` when the last leaves) instead of `room:*`.

---

## 6. Common use cases

| Use case | Notes |
|---|---|
| WebSocket / SSE broadcast across instances | Redis Pub/Sub or Socket.IO Redis adapter |
| Cache invalidation (L1 in-process caches) | publish `invalidate product:42`; lost message → TTL as safety net |
| Config / feature flag change | push notification + periodic poll fallback |
| Domain events between services | use durable pub/sub (Kafka, SNS+SQS, JetStream) |
| Live dashboards, presence updates | ephemeral is fine |
| Mobile push notifications | FCM/APNs are pub/sub-like services |

---

## 7. Design concerns

### Message design
- Events are **facts in the past tense**: `OrderPlaced`, `UserEmailChanged`
- Include `eventId`, `type`, `version`, `occurredAt`, `correlationId`
- **Fat vs thin events:** full data (consumers don't call back, but bigger and might leak data) vs just IDs (consumers fetch, adding load and coupling)
- Version schemas; consumers must tolerate unknown fields

### Ordering
Most pub/sub systems give per-publisher or per-partition order at best. Include sequence/version numbers so subscribers can discard stale updates.

### Duplicates
Durable systems are at-least-once → subscribers must be **idempotent** (dedupe by `eventId`).

### Backpressure
A slow subscriber must not slow the publisher. Ephemeral systems drop or disconnect slow subscribers; durable systems let them lag (monitor lag!).

### Observability
"Who consumes this topic?" becomes hard to answer. Maintain an event catalogue; propagate trace context in message headers.

---

## 8. Trade-offs

| Gain | Cost |
|---|---|
| loose coupling, easy to add subscribers | hidden dependencies, hard-to-trace flows |
| scalable fan-out | eventual consistency |
| publisher unaffected by subscriber speed (durable) | duplicates/ordering to handle |
| | ephemeral variants lose messages |

---

## 9. Production checklist

- [ ] Durable system for events that matter; ephemeral only for signals
- [ ] Separate subscriber connection(s); auto-resubscribe on reconnect
- [ ] Idempotent subscribers with `eventId` dedupe
- [ ] Schema versioning; event catalogue
- [ ] Monitor subscriber lag / dropped connections / output buffers
- [ ] Fallback for missed ephemeral messages (TTL, periodic resync)

---

## 10. Interview questions

1. **Pub/sub vs message queue?** — Fan-out to all subscribers vs one consumer per message.
2. **Can Redis Pub/Sub lose messages?** — Yes; no persistence, offline subscribers miss them. Use Streams/Kafka for durability.
3. **How do you broadcast WebSocket messages across servers?** — Every server subscribes to a shared channel; publish there; each delivers to local sockets.
4. **How do you invalidate in-process caches on 20 instances?** — Publish invalidation events + short TTL as safety net.
5. **Fat vs thin events?** — Self-contained vs reference-only; trade payload size and coupling.
6. **How do you handle a slow subscriber?** — Durable: let it lag with monitoring/scaling; ephemeral: drop/disconnect to protect the broker.

**Prev:** [10 — WebSocket](10-websocket.md) · **Next:** [12 — Search](12-search.md)
