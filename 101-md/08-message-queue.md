# 08 — Message Queue

> Don't make the user wait for work they don't need to see finish. Put it in a queue, return immediately, and let workers do it.

---

## 1. The problem

```text
POST /orders
  → save order            30 ms
  → charge card          400 ms
  → send email           800 ms   (SMTP slow)
  → generate invoice PDF 1200 ms
  → notify warehouse     300 ms
  = 2.7 s response, and if email server is down → whole order fails
```

Synchronous chains are **slow** (latencies add), **fragile** (any failure fails all), and **tightly coupled** (order service must know every consumer).

With a **message queue**:

```text
POST /orders → save order → publish "OrderCreated" → 201 Created (50 ms)

             ┌──▶ email worker
queue ───────┼──▶ invoice worker
             └──▶ warehouse worker
```

---

## 2. Benefits

| Benefit | Explanation |
|---|---|
| **Async / lower latency** | user gets response before slow work runs |
| **Decoupling** | producer doesn't know consumers; add new ones without changing it |
| **Load leveling** | spike of 10k orders/s buffered; workers process at steady 500/s |
| **Resilience** | email server down → messages wait, retry later; nothing lost |
| **Scalability** | add more workers (competing consumers) |

---

## 3. Core concepts

```text
producer ──publish──▶ [ exchange ] ──route──▶ [ queue ] ──deliver──▶ consumer ──ack──▶
```

| Term | Meaning |
|---|---|
| Producer | sends messages |
| Consumer / worker | receives and processes |
| Queue | buffer holding messages until consumed |
| Broker | server managing queues (RabbitMQ, SQS, ActiveMQ) |
| Ack | consumer confirms success → broker deletes message |
| Nack / reject | consumer reports failure → requeue or dead-letter |
| Prefetch | how many un-acked messages a consumer may hold |
| DLQ | dead-letter queue for messages that keep failing |

### Two messaging models

- **Point-to-point (work queue):** each message is processed by **one** consumer. Competing consumers scale throughput.
- **Publish/subscribe:** each message is delivered to **every** subscribed queue (→ guide 11).

RabbitMQ does both via **exchanges**:

| Exchange | Routing |
|---|---|
| direct | exact routing key match |
| topic | pattern: `order.*.eu`, `order.#` |
| fanout | all bound queues |
| headers | match on headers |

---

## 4. Delivery guarantees

| Guarantee | Meaning | How |
|---|---|---|
| **At-most-once** | may lose, never duplicate | ack before processing |
| **At-least-once** | never lose, may duplicate | ack **after** processing (default choice) |
| **Exactly-once** | neither | not truly possible end-to-end over a network; achieve **exactly-once effect** with at-least-once + **idempotent consumers** |

Why duplicates happen: worker processes the message, then crashes before ack → broker redelivers.

**Therefore: every consumer must be idempotent** (→ guide 20).

```ts
async function handle(msg: { id: string; orderId: string }) {
  const inserted = await db.query(
    "INSERT INTO processed_messages(id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id", [msg.id]);
  if (inserted.rowCount === 0) return;          // already done
  await sendInvoice(msg.orderId);
}
```
(Better: do the dedup insert and the business write in the same DB transaction.)

---

## 5. Retries and dead-letter queues

```text
queue ──▶ worker ✘ ──▶ retry queue (TTL 5s) ──▶ back to queue ✘ ──▶ retry (30s) ✘ ──▶ ... ──▶ DLQ
```

- **Transient errors** (timeout, 503) → retry with **exponential backoff**
- **Permanent errors** (invalid payload, bug) → straight to DLQ, retrying won't help
- Track attempts in a header (`x-retry-count`)
- **Poison message** — one message that always crashes the worker; without a retry cap it blocks the queue forever
- DLQ needs **monitoring and a replay tool**, otherwise it's a silent graveyard

---

## 6. Backpressure and flow control

Producers faster than consumers → queue grows without bound → broker memory/disk fills.

- **Prefetch** (`channel.prefetch(10)`) — don't flood a single worker
- **Autoscale workers** on queue depth
- **Max queue length** + overflow policy (reject-publish / drop-head)
- **Producer-side** rate limiting or blocking when broker signals pressure
- Monitor: **queue depth**, **consumer lag**, **age of oldest message**

Little's Law again: if workers process 100 msg/s and you have 60,000 queued, the newest waits ~10 minutes.

---

## 7. Ordering

A single queue with **one** consumer is FIFO. With competing consumers, messages finish **out of order** (worker 2 may finish message 5 before worker 1 finishes message 4).

If order matters per entity (all events for order #42 in order):
- partition by key so one consumer handles one key (Kafka partitions, RabbitMQ consistent-hash exchange, SQS FIFO message groups)
- or make handlers order-insensitive (versions, timestamps)

---

## 8. The dual-write problem and the outbox pattern

```ts
await db.insert(order);          // ✔
await broker.publish(event);     // ✘ crash here → order exists, event never sent
```

**Transactional outbox:**
1. In the **same DB transaction**: insert order + insert row in `outbox` table
2. A relay process reads `outbox` and publishes, marking rows sent (or CDC via Debezium)
3. At-least-once delivery → consumers idempotent

```sql
BEGIN;
INSERT INTO orders (...) VALUES (...);
INSERT INTO outbox (id, topic, payload) VALUES (gen_random_uuid(), 'order.created', '{...}');
COMMIT;
```

---

## 9. Node.js sketch — RabbitMQ with amqplib

```ts
import amqp from "amqplib";

const conn = await amqp.connect(process.env.AMQP_URL!);
const ch = await conn.createChannel();
await ch.assertExchange("dlx", "direct", { durable: true });
await ch.assertQueue("emails.dlq", { durable: true });
await ch.bindQueue("emails.dlq", "dlx", "emails");
await ch.assertQueue("emails", {
  durable: true,
  arguments: { "x-dead-letter-exchange": "dlx", "x-dead-letter-routing-key": "emails" },
});

// producer
ch.sendToQueue("emails", Buffer.from(JSON.stringify({ id: crypto.randomUUID(), to: "a@x.com" })),
  { persistent: true, contentType: "application/json" });

// consumer
await ch.prefetch(10);
await ch.consume("emails", async (msg) => {
  if (!msg) return;
  try {
    await sendEmail(JSON.parse(msg.content.toString()));
    ch.ack(msg);
  } catch (err) {
    ch.nack(msg, false, false); // don't requeue → goes to DLQ
  }
});
```

`durable` queue + `persistent` messages + publisher confirms = survives broker restart.

---

## 10. Choosing a broker

| | RabbitMQ | Kafka | AWS SQS | Redis Streams / BullMQ |
|---|---|---|---|---|
| Model | queue, smart routing | distributed log | managed queue | lightweight queue |
| Message after consume | deleted | retained (replayable) | deleted | retained/trimmed |
| Throughput | ~10k–100k/s | millions/s | very high, managed | high |
| Ordering | per queue | per partition | FIFO queues | per stream |
| Best for | task queues, routing, RPC | event streaming, replay, analytics | zero-ops queues | Node apps, jobs, delays |

For Node background jobs (emails, thumbnails, delayed jobs) **BullMQ** on Redis is very common.

---

## 11. Trade-offs

- **Latency of the work increases** (it's later), even though response latency drops
- **Eventual consistency** — the user may not see the invoice yet
- **Operational complexity** — another system to run, monitor, and secure
- **Debugging harder** — flows span processes; need correlation IDs (guide 21)
- **Duplicates** — must design idempotency

---

## 12. Production checklist

- [ ] Durable queues, persistent messages, publisher confirms
- [ ] Ack after processing; idempotent consumers
- [ ] Retry with backoff + max attempts + DLQ + alerting + replay
- [ ] Prefetch tuned; workers autoscale on depth/age
- [ ] Outbox pattern for DB + publish
- [ ] Message schema versioned; correlation ID in headers
- [ ] Graceful worker shutdown (finish current message, stop consuming)

---

## 13. Interview questions

1. **Why use a message queue?** — Async processing, decoupling, load leveling, resilience.
2. **At-least-once vs exactly-once?** — Exactly-once delivery isn't practical; use at-least-once + idempotency.
3. **What's a DLQ?** — Where messages go after max retries or permanent failure, for inspection/replay.
4. **How do you keep ordering with multiple consumers?** — Partition by key; one consumer per partition.
5. **How do you save to DB and publish atomically?** — Transactional outbox / CDC.
6. **Queue keeps growing — what do you do?** — Scale consumers, find slow dependency, apply backpressure, check poison messages.
7. **RabbitMQ vs Kafka?** — Queue that deletes on ack with rich routing vs retained replayable partitioned log for high-throughput streams.

**Prev:** [07 — Rate Limiting](07-rate-limiting.md) · **Next:** [09 — Kafka](09-kafka.md)
