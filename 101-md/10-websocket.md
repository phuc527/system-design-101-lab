# 10 — WebSocket

> HTTP is request/response: the server can't speak first. WebSocket gives a persistent, full-duplex channel so the server can push data the moment it happens.

---

## 1. The problem

Chat, live notifications, multiplayer games, stock tickers, collaborative editing — the **server** knows when something changes. How does the client find out?

### Options compared

| Technique | How | Latency | Overhead |
|---|---|---|---|
| **Short polling** | `GET /messages` every 2 s | up to interval | huge — most responses empty |
| **Long polling** | server holds request until data or timeout, client re-requests | low | one request per message, reconnect churn |
| **Server-Sent Events (SSE)** | one long HTTP response streaming `text/event-stream` | low | server → client only, text, auto-reconnect |
| **WebSocket** | upgraded TCP connection, both directions | lowest | small frames (2–14 bytes header) |

Use **SSE** for one-way feeds (notifications, live scores, LLM token streaming) — simpler, works over plain HTTP. Use **WebSocket** when the client sends frequently too (chat, games, collaboration).

---

## 2. How WebSocket works

### Handshake (HTTP Upgrade)

```http
GET /chat HTTP/1.1
Host: example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13

HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

After `101`, the same TCP connection carries **frames** both ways until one side closes.

### Frames
- text, binary, ping, pong, close
- client → server frames are masked
- `ws://` (plain) or `wss://` (TLS — always use in production; also avoids proxies breaking the connection)

### Keepalive
Idle connections are killed by NATs, LBs (often 60 s idle timeout), and proxies. Send **ping/pong** every ~25–30 s and drop clients that don't answer (detects dead "half-open" connections).

---

## 3. Node.js sketch — chat with rooms (`ws`)

```ts
import { WebSocketServer, WebSocket } from "ws";

type Client = WebSocket & { isAlive: boolean; rooms: Set<string>; userId: string };
const rooms = new Map<string, Set<Client>>();
const wss = new WebSocketServer({ port: 8081 });

wss.on("connection", (raw, req) => {
  const ws = raw as Client;
  ws.isAlive = true;
  ws.rooms = new Set();
  ws.userId = authenticate(req); // token from query/cookie, verified on upgrade

  ws.on("pong", () => (ws.isAlive = true));
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "join") {
      if (!rooms.has(msg.room)) rooms.set(msg.room, new Set());
      rooms.get(msg.room)!.add(ws);
      ws.rooms.add(msg.room);
    } else if (msg.type === "say") {
      broadcast(msg.room, { from: ws.userId, text: msg.text });
    }
  });
  ws.on("close", () => ws.rooms.forEach((r) => rooms.get(r)?.delete(ws)));
});

function broadcast(room: string, payload: unknown) {
  const data = JSON.stringify(payload);
  for (const c of rooms.get(room) ?? []) {
    if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 1_000_000) c.send(data); // skip slow clients
  }
}

setInterval(() => {
  for (const c of wss.clients as Set<Client>) {
    if (!c.isAlive) { c.terminate(); continue; }
    c.isAlive = false;
    c.ping();
  }
}, 30_000);
```

Libraries: `ws` (minimal, fast), **Socket.IO** (rooms, acks, reconnection, fallback to long-polling, Redis adapter), uWebSockets.js (very high performance).

---

## 4. The scaling problem

WebSocket connections are **stateful**: each connection lives on one server process.

```text
Alice ──ws──▶ server A          Bob ──ws──▶ server B
Alice sends "hi" to room 1 → server A broadcasts to ITS clients only → Bob never gets it ✗
```

### Solution: a message backplane (pub/sub)

```text
Alice ─▶ A ──publish room:1──▶ [ Redis Pub/Sub / NATS / Kafka ] ──▶ A, B, C
                                                                    └─ B delivers to Bob ✔
```

Every server subscribes to the channels for rooms its clients are in; every message is published to the backplane, and each server delivers locally. Socket.IO: `@socket.io/redis-adapter`. (→ guide 11)

### Load balancer considerations

- LB must support the **Upgrade** header (Nginx: `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`)
- Raise idle timeouts (`proxy_read_timeout 3600s`) or rely on pings
- **Sticky sessions** needed only if using Socket.IO's long-polling fallback (multiple HTTP requests must hit the same server)
- Balance by **connection count** (least-conn), not request count — connections are long-lived

### Presence ("who's online")
Store in Redis: `SADD online:room1 user42` with heartbeats / expiring keys (`SET presence:user42 1 EX 60` refreshed by pings). In-memory presence breaks with multiple servers.

---

## 5. Capacity and limits

- Each connection costs memory (~10–50 KB in Node with buffers), a file descriptor, and keepalive traffic
- One well-tuned Node process can hold **tens of thousands** to 100k+ idle connections; message rate (fan-out) is usually the real limit
- Raise OS limits: `ulimit -n`, ephemeral ports on the LB
- **Fan-out cost:** a message to a room of 100,000 users = 100,000 sends. Large broadcasts need batching, sharding rooms across servers, or a different model

---

## 6. Reliability concerns

| Concern | Approach |
|---|---|
| **Reconnects** | client reconnects with **exponential backoff + jitter** (avoid thundering herd after a deploy) |
| **Missed messages during disconnect** | messages have sequence IDs; on reconnect client sends `lastSeenId`, server replays from a store (Redis Stream, DB) |
| **Deploys** | server sends close frame / "reconnect" message, drains slowly; don't kill 50k sockets at once |
| **Slow consumers** | check `bufferedAmount`; drop or disconnect clients that can't keep up (backpressure) |
| **Delivery guarantee** | WebSocket ≈ at-most-once across reconnects; add app-level acks for important messages |
| **Ordering** | per connection TCP order; across servers use per-room sequence numbers |

---

## 7. Security

- **Authenticate on the handshake** (token in cookie or `Sec-WebSocket-Protocol`/query, verified before `101`). Query tokens can leak into logs → prefer short-lived tickets.
- **Check `Origin`** — browsers don't apply CORS to WebSockets → Cross-Site WebSocket Hijacking.
- **Authorize per message** (can this user post in this room?)
- **Validate and size-limit** messages (`maxPayload`), **rate limit** per connection
- Always `wss://`

---

## 8. Trade-offs

| Gain | Cost |
|---|---|
| real-time, low overhead per message | stateful servers — harder to scale, deploy, and balance |
| bidirectional | no HTTP caching, harder observability |
| | need a backplane, presence store, reconnect logic |

---

## 9. Production checklist

- [ ] `wss://`, auth on upgrade, Origin check
- [ ] Ping/pong heartbeat; LB idle timeout > ping interval
- [ ] Redis (or similar) backplane for multi-instance broadcast
- [ ] Client reconnect with backoff + jitter, resume from last message ID
- [ ] Backpressure on slow clients; max payload; per-connection rate limit
- [ ] Metrics: open connections per instance, messages in/out, send buffer sizes
- [ ] Graceful, staggered connection draining on deploy

---

## 10. Interview questions

1. **Polling vs long polling vs SSE vs WebSocket?** — See table; SSE for one-way, WS for bidirectional.
2. **How does the WebSocket handshake work?** — HTTP `Upgrade` → `101 Switching Protocols` → frames over the same TCP connection.
3. **How do you scale WebSockets to many servers?** — Pub/sub backplane (Redis) so any server can deliver to its local clients; connection-aware LB.
4. **Do you need sticky sessions?** — Not for pure WebSocket (connection itself is pinned); yes for Socket.IO polling fallback.
5. **How do you detect dead connections?** — Ping/pong heartbeats with timeout.
6. **How do clients not miss messages during reconnect?** — Sequence IDs + replay from durable store.
7. **Design a chat system for 10M concurrent users.** — Gateway tier of WS servers, connection registry, pub/sub/Kafka for routing, message store (Cassandra), presence in Redis, push notifications for offline users.

**Prev:** [09 — Kafka](09-kafka.md) · **Next:** [11 — Pub/Sub](11-pub-sub.md)
