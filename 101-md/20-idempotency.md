# 20 — Idempotency

> An operation is idempotent if doing it once or many times has the same effect. In distributed systems, everything gets retried — so everything important must be idempotent.

---

## 1. The problem

```text
client ──POST /payments {amount: 100}──▶ server ──charge card ✔──▶ save ✔
client ◀────────── response lost (timeout / network drop) ──────────
client: "did it work? I'll retry"
client ──POST /payments {amount: 100}──▶ server ──charge card ✔  ← charged twice ✗
```

Sources of duplicates:
- client retries after timeout (guide 19)
- user double-clicks "Pay"
- load balancer / gateway retries
- message queue redelivery (at-least-once, guide 08)
- mobile app resends after reconnect

You cannot get **exactly-once delivery** over an unreliable network. You can get **exactly-once effect**: at-least-once delivery + idempotent processing.

---

## 2. Idempotency by operation type

| Operation | Naturally idempotent? |
|---|---|
| `GET /orders/42` | ✅ read |
| `PUT /users/42 {name: "A"}` | ✅ set to a value |
| `DELETE /orders/42` | ✅ effect is "gone" (2nd call may return 404, effect same) |
| `POST /orders` | ❌ creates a new order each time |
| `PATCH /accounts/42 {balance: +100}` | ❌ relative change |
| `UPDATE stock SET qty = qty - 1` | ❌ |
| `UPDATE stock SET qty = 9 WHERE version = 7` | ✅ conditional |

Design tip: prefer **absolute** state changes ("set status = PAID") over **relative** ones ("add 100") where possible.

---

## 3. The Idempotency-Key pattern (Stripe-style)

Client generates a unique key per **logical operation** and sends it on every retry of that operation.

```http
POST /payments
Idempotency-Key: 5f3c1d0e-8b1a-4c1e-9f0b-2a6d7e8c9b10
Content-Type: application/json

{ "orderId": "ord_42", "amount": 100 }
```

Server logic:

```text
1. look up key
   ├─ not found → insert key with status=IN_PROGRESS (atomically) → process → store response, status=COMPLETED → return
   ├─ COMPLETED → return the stored response (same status code + body). Don't re-execute.
   ├─ IN_PROGRESS → 409 Conflict ("request in progress, retry later")
   └─ found but request body differs → 422 (key reused for a different request)
2. keys expire after e.g. 24 h
```

### Table

```sql
CREATE TABLE idempotency_keys (
  key            text        NOT NULL,
  user_id        bigint      NOT NULL,
  request_hash   text        NOT NULL,
  status         text        NOT NULL,      -- IN_PROGRESS | COMPLETED
  response_code  int,
  response_body  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)                -- scope keys per user/client
);
```

### Node.js middleware

```ts
import { createHash } from "node:crypto";

export function idempotent() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header("Idempotency-Key");
    if (!key) return res.status(400).json({ error: "Idempotency-Key required" });
    const userId = req.user.id;
    const hash = createHash("sha256").update(req.method + req.path + JSON.stringify(req.body)).digest("hex");

    // atomic claim: only one request can insert
    const claimed = await db.query(
      `INSERT INTO idempotency_keys (key, user_id, request_hash, status)
       VALUES ($1, $2, $3, 'IN_PROGRESS') ON CONFLICT DO NOTHING RETURNING key`,
      [key, userId, hash]);

    if (claimed.rowCount === 0) {
      const { rows: [row] } = await db.query(
        `SELECT * FROM idempotency_keys WHERE key = $1 AND user_id = $2`, [key, userId]);
      if (row.request_hash !== hash) return res.status(422).json({ error: "key reused with different payload" });
      if (row.status === "IN_PROGRESS") return res.status(409).set("Retry-After", "1").json({ error: "in_progress" });
      res.setHeader("Idempotent-Replayed", "true");
      return res.status(row.response_code).json(row.response_body);
    }

    // capture the response to store it
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const save = res.statusCode >= 500
        ? db.query(`DELETE FROM idempotency_keys WHERE key=$1 AND user_id=$2`, [key, userId])   // allow retry of server errors
        : db.query(`UPDATE idempotency_keys SET status='COMPLETED', response_code=$3, response_body=$4
                    WHERE key=$1 AND user_id=$2`, [key, userId, res.statusCode, body]);
      save.catch((err) => logger.error({ err }, "failed to persist idempotency result"));
      return originalJson(body);
    };
    next();
  };
}

app.post("/payments", requireAuth, idempotent(), paymentsController.create);
```

Policy decisions:
- **5xx**: delete key so client can retry (or store and replay — Stripe replays only successful/4xx results)
- **4xx validation errors**: store & replay (same request → same answer)
- **Crash while IN_PROGRESS**: stale IN_PROGRESS rows need a timeout/recovery (e.g. consider stale after 60 s; check the payment provider's state before re-executing)

### Strongest version: same transaction
Do the idempotency record and the business write in **one DB transaction**, so they can't disagree:

```sql
BEGIN;
INSERT INTO idempotency_keys (...) VALUES (...);         -- conflicts → abort, replay
INSERT INTO payments (order_id, amount, ...) VALUES (...);
UPDATE idempotency_keys SET status='COMPLETED', response_body=... ;
COMMIT;
```

External side effects (calling Stripe, sending email) can't join your DB transaction → pass **your idempotency key to the provider** too (Stripe, Adyen, PayPal all accept one).

---

## 4. Other idempotency techniques

### Unique constraints (natural keys)
```sql
CREATE UNIQUE INDEX ON payments (order_id);   -- one payment per order
INSERT INTO payments (...) ON CONFLICT (order_id) DO NOTHING;
```
Often the simplest and most robust: let the database reject duplicates.

### Client-generated IDs
`PUT /orders/{client-generated-uuid}` — creating the same ID twice is a no-op. Turns POST into idempotent PUT.

### Conditional writes / optimistic concurrency
```sql
UPDATE accounts SET balance = 900, version = 8 WHERE id = 42 AND version = 7;
```
A replay finds `version = 8` → 0 rows updated → no double effect. HTTP: `If-Match: "etag"`.

### State machines
```text
PENDING → PAID → SHIPPED
```
`UPDATE orders SET status='PAID' WHERE id=42 AND status='PENDING'` — second attempt changes nothing.

### Message consumer deduplication
Store processed `messageId`s (in the same transaction as the effect) or use Redis `SET msg:<id> 1 NX EX 86400` (fast, but not transactional with your DB).

---

## 5. Where to enforce

```text
client → gateway → service → DB / provider
```
- Clients: generate the key once per user action (e.g. when the checkout page loads), reuse on retries
- Service: enforce (gateway can help, but the service owns correctness)
- DB: constraints as the last line of defence
- External providers: forward the key

---

## 6. Failure modes

| Mistake | Result |
|---|---|
| new key generated on each retry | no protection at all |
| check-then-insert (not atomic) | two concurrent requests both pass the check |
| key not scoped to user | one user's key collides with/replays another's response (data leak) |
| key stored in Redis only, effect in DB | Redis failover loses keys → duplicates |
| not comparing payload | same key reused for different amount → wrong replay |
| stuck IN_PROGRESS forever | user can never complete action |
| keys never expire | unbounded table growth |

---

## 7. Interview questions

1. **What is idempotency?** — Repeating an operation has the same effect as doing it once.
2. **Which HTTP methods are idempotent?** — GET, HEAD, PUT, DELETE, OPTIONS; POST and PATCH are not by default.
3. **Design a payment API that's safe to retry.** — Idempotency-Key per logical payment, atomic claim, store and replay response, unique constraint on order, forward key to provider.
4. **Why isn't exactly-once delivery possible, and what do we do?** — Acks can be lost; use at-least-once + idempotent consumers for exactly-once effect.
5. **Two identical requests arrive concurrently — what happens?** — One wins the atomic insert; the other gets 409 or the replayed result.
6. **How long do you keep idempotency keys?** — Longer than the client's maximum retry window (often 24 h), then expire.

**Prev:** [19 — Retry & Timeout](19-retry-timeout.md) · **Next:** [21 — Observability](21-observability.md)
