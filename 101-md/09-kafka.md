# 09 — Kafka

> Kafka is not a queue — it's a **distributed, partitioned, replicated commit log**. Messages aren't deleted when read; consumers just move a pointer.

---

## 1. The problem Kafka solves

- Many systems need the **same events** (orders → billing, analytics, search index, fraud, email)
- Some consumers need to **replay** history (rebuild a search index, fix a bug and reprocess)
- Volume is huge: **millions of events per second**
- Strict **per-entity ordering** is needed

A classic queue deletes messages after one consumer acks them. Kafka keeps them for a retention period, and any number of consumer groups read independently.

---

## 2. Core concepts

```text
Topic "orders"
 ├─ Partition 0: [0][1][2][3][4][5][6] ──▶ append
 ├─ Partition 1: [0][1][2][3][4]       ──▶ append
 └─ Partition 2: [0][1][2][3][4][5]    ──▶ append
                  ▲ offset
```

| Term | Meaning |
|---|---|
| **Broker** | a Kafka server; a cluster has several |
| **Topic** | named stream of events (`orders`, `payments`) |
| **Partition** | an ordered, append-only log; unit of parallelism and ordering |
| **Offset** | position of a record in a partition (0, 1, 2, …) |
| **Record** | key + value + headers + timestamp |
| **Producer** | appends records to topics |
| **Consumer group** | set of consumers sharing work; each partition goes to exactly one member |
| **Committed offset** | where a group will resume after restart |
| **Retention** | keep data N days or N GB (or forever with compaction) |
| **Replication factor** | copies of each partition across brokers |

---

## 3. Partitions and keys — ordering

Producer picks partition by **key**: `partition = hash(key) % numPartitions`.

```text
key = orderId 42 → always partition 1 → events for order 42 are in order
key = null       → spread (sticky/round robin) → no ordering guarantee
```

**Ordering is guaranteed only within a partition.** There is no global order across a topic.

Choose the key = the entity whose events must stay ordered (orderId, userId, accountId).

⚠ Hot key → hot partition. ⚠ Changing partition count changes `hash % N` → key-to-partition mapping changes (ordering breaks during transition). Pick a generous partition count up front.

---

## 4. Consumer groups — scaling reads

```text
topic: 4 partitions

group "billing" (2 consumers)          group "analytics" (4 consumers)
 C1 ← P0, P1                            C1 ← P0
 C2 ← P2, P3                            C2 ← P1
                                        C3 ← P2
                                        C4 ← P3
```

- Each **group** gets **every** message (pub/sub between groups)
- Within a group, each partition is consumed by **one** consumer (queue semantics within group)
- **Max useful consumers in a group = number of partitions.** A 5th consumer on 4 partitions sits idle.
- **Rebalance:** when a consumer joins/leaves/crashes, partitions are reassigned (brief pause; cooperative rebalancing reduces it)

---

## 5. Offsets and delivery semantics

The consumer **commits** the offset it has processed.

| Commit timing | Semantics | Risk |
|---|---|---|
| commit **before** processing | at-most-once | crash → message skipped |
| commit **after** processing | at-least-once (usual) | crash → message reprocessed |
| transactions (read-process-write in Kafka) | exactly-once *within Kafka* | more complex; external side effects still need idempotency |

Auto-commit (`enable.auto.commit`, every 5 s) can commit offsets of messages not yet processed → potential loss. For important work, commit manually after processing.

**Consumer lag** = latest offset − committed offset. The #1 Kafka health metric.

---

## 6. Durability and replication

Each partition has one **leader** and followers on other brokers. Followers in sync = **ISR** (in-sync replicas).

```text
P0: leader broker1, followers broker2, broker3   (RF=3)
```

Producer `acks`:

| acks | Meaning | Durability |
|---|---|---|
| 0 | fire and forget | can lose |
| 1 | leader wrote it | lose if leader dies before replicating |
| **all** | all ISR wrote it | safe with `min.insync.replicas=2` |

Recommended durable setup: `replication.factor=3`, `min.insync.replicas=2`, `acks=all`, `enable.idempotence=true` (no duplicates from producer retries).

Cluster metadata/leader election: **KRaft** (Kafka's built-in Raft) — ZooKeeper is no longer needed.

---

## 7. Why Kafka is fast

1. **Sequential disk I/O** — append-only writes, sequential reads (disks love this)
2. **OS page cache** — recent data served from RAM
3. **Zero-copy** (`sendfile`) — bytes go disk → socket without passing through user space
4. **Batching + compression** — producers batch records (`linger.ms`, `batch.size`), compress whole batches
5. **Partitioning** — parallelism across brokers and consumers

---

## 8. Log compaction

Retention by time deletes old data. **Compaction** instead keeps the **latest value per key**:

```text
before: (u1, A) (u2, B) (u1, C) (u3, D) (u2, null)
after:  (u1, C) (u3, D)                 ← null = tombstone → delete
```

Use for "current state" topics: user profiles, config, KTable changelogs. A new consumer can rebuild full state by reading the compacted topic.

---

## 9. Node.js sketch — KafkaJS

```ts
import { Kafka } from "kafkajs";

const kafka = new Kafka({ clientId: "order-svc", brokers: ["localhost:9092"] });

// producer
const producer = kafka.producer({ idempotent: true });
await producer.connect();
await producer.send({
  topic: "orders",
  acks: -1, // all
  messages: [{ key: String(order.id), value: JSON.stringify({ type: "OrderCreated", order }) }],
});

// consumer
const consumer = kafka.consumer({ groupId: "billing" });
await consumer.connect();
await consumer.subscribe({ topic: "orders", fromBeginning: false });
await consumer.run({
  autoCommit: false,
  eachMessage: async ({ topic, partition, message }) => {
    await billing.handle(JSON.parse(message.value!.toString())); // idempotent!
    await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
  },
});
```

Note the committed offset is **next** offset to read (`offset + 1`).

---

## 10. Common patterns

| Pattern | Description |
|---|---|
| **Event-driven microservices** | services publish domain events; others react |
| **CDC** | Debezium streams DB changes into Kafka (outbox, cache invalidation, search sync) |
| **Event sourcing** | state = replay of events |
| **Stream processing** | Kafka Streams / Flink: windows, joins, aggregations in real time |
| **Log aggregation / metrics pipeline** | apps → Kafka → Elasticsearch / warehouse |
| **Retry topics** | `orders.retry.5s`, `orders.retry.1m`, `orders.dlq` |

---

## 11. Kafka vs RabbitMQ

| | Kafka | RabbitMQ |
|---|---|---|
| Model | log; consumers track offsets | queue; broker tracks delivery |
| After consumption | retained | deleted |
| Replay | ✅ | ❌ (not natively) |
| Ordering | per partition | per queue |
| Throughput | millions/s | tens–hundreds of thousands/s |
| Routing | by topic/partition | rich (topic, headers, fanout) |
| Per-message features | basic | priorities, TTL, delayed, per-message ack |
| Scaling consumers | ≤ partitions | unlimited competing consumers |
| Best for | event streaming, analytics, many readers | task queues, complex routing, RPC |

---

## 12. Failure modes

| Problem | Effect | Fix |
|---|---|---|
| slow consumer | lag grows | scale consumers (≤ partitions), optimise handler, batch |
| poison message | partition stuck (blocks all later messages) | catch, send to DLQ topic, commit and move on |
| rebalance storms | processing pauses repeatedly | tune `session.timeout`/`max.poll.interval`, cooperative sticky assignor |
| hot partition | one consumer overwhelmed | better key, salting |
| broker loss with RF=1 | data loss | RF=3, min ISR=2 |
| auto-commit before processing | silent loss | manual commit after processing |

---

## 13. Production checklist

- [ ] RF=3, `min.insync.replicas=2`, `acks=all`, idempotent producer
- [ ] Partition count planned for peak consumer parallelism
- [ ] Key chosen for ordering and even spread
- [ ] Manual commits after processing; idempotent handlers
- [ ] DLQ / retry topics
- [ ] Monitor consumer lag, under-replicated partitions, broker disk
- [ ] Schema registry (Avro/Protobuf/JSON Schema) for compatibility

---

## 14. Interview questions

1. **How does Kafka guarantee ordering?** — Only within a partition; use a key so related events share a partition.
2. **More consumers than partitions?** — Extras are idle; partitions cap group parallelism.
3. **What is consumer lag?** — Distance between log end and committed offset; key health signal.
4. **How do you avoid losing messages?** — `acks=all`, RF=3, min ISR 2, commit after processing.
5. **Why is Kafka fast?** — Sequential I/O, page cache, zero-copy, batching, partitions.
6. **What is log compaction?** — Keep latest record per key; rebuild state.
7. **When choose Kafka over RabbitMQ?** — Multiple independent consumers, replay, very high throughput, stream processing.

**Prev:** [08 — Message Queue](08-message-queue.md) · **Next:** [10 — WebSocket](10-websocket.md)
