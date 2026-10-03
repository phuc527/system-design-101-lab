# Request Flow

Follow one request, `GET /api/latency?ms=100` sent to the **horizontal** container, from your terminal to the response. Every step adds time and is a place where things can fail.

```text
curl (host)
  ↓  ① DNS + TCP connect to localhost:3003
Docker Desktop port forward (host → VM → container)
  ↓  ② network hop
cluster primary (pid 1)
  ↓  ③ hands connection to a worker (round-robin)
worker (pid 14)
  ↓  ④ middleware: X-Instance, start timer, JSON parser
  ↓  ⑤ router match: GET /api/latency
  ↓  ⑥ chaos middleware: extra delay? injected failure?
  ↓  ⑦ controller: validate ms, await sleep(100)   ← "storage/IO" stand-in
  ↓  ⑧ res.json(...) → timer stops → stats recorded
  ↑  ⑨ network hop back
curl prints response
```

## Step by step

### ① Connection: client → host

- **HTTP request:** `GET /api/latency?ms=100 HTTP/1.1`, `Host: localhost:3003`.
- **Cost:** a new TCP connection is a 3-way handshake (1 round trip). On localhost it's ~0.1ms. Across the internet it's 20–200ms, plus TLS (1–2 more round trips). That's why HTTP **keep-alive** and connection pooling matter. autocannon and k6 reuse connections, single `curl` calls don't.
- **Failure:** nothing listening → `ECONNREFUSED` (curl prints `000`). This is what you see in experiment 9 while a container restarts.

### ② Network hop: host → container

- Docker Desktop on Windows/macOS runs containers in a VM. Traffic to `localhost:3003` is forwarded into the VM and to the container's port 3000.
- **Cost:** measured at roughly +20–40ms under load on the test machine. On Linux servers with native Docker it's near zero.
- **Failure:** port mapping missing (`ports:` not set), or the container is restarting.

### ③ Cluster primary → worker

- The primary process owns the listening socket. On Linux, Node's default `SCHED_RR` policy hands each new **connection** (not each request!) to the next worker.
- With keep-alive, all requests on one connection go to the same worker. That's why a single autocannon connection would always hit one pid.
- **Failure:** the chosen worker just died → that connection errors. New connections go to living workers. The primary forks a replacement (~250ms).

### ④ Middleware

- `instanceHeader` → `X-Instance: horizontal-2cpu-2proc/14`
- `requestMetrics` → records `process.hrtime.bigint()` as start time
- `express.json()` → no body on GET, skipped quickly
- **Failure:** a malformed JSON body on POST → `400 INVALID_JSON`.

### ⑤ Routing

- Express walks its route table and matches `GET /api/latency`.
- **Failure:** no match → `404 NOT_FOUND` (still recorded in metrics as `unmatched`).

### ⑥ Chaos (only on `/api/*`)

- If `extraLatencyMs > 0` → `await sleep(extraLatencyMs)`: simulates a slow dependency or network.
- If `random() < failureRate` → `throw new ChaosError()` → `500 CHAOS_INJECTED_FAILURE`.

### ⑦ Processing (the "storage" step)

- `intQuery()` validates `ms` → `400 BAD_REQUEST` if not an integer in range.
- `await sleep(100)` stands in for I/O: a database query, a Redis call, an HTTP call to another service. **The event loop is free during the wait** and serves other requests.
- On `/api/cpu`, this step instead runs `fibonacci(n)` **synchronously**. The event loop is blocked and every other request on this worker queues up behind it (experiment 4).
- In later labs this step becomes real: Redis (lab 02/03), PostgreSQL (lab 04/05), Kafka (lab 09).

### ⑧ Response

- `res.json()` serializes the object, sets `Content-Type` and `Content-Length`, writes to the socket.
- `res.on("finish")` fires → `StatsService.record("GET /api/latency", 100.4, 200)`.
- **Server latency** (what `/metrics` shows) ends here.

### ⑨ Back to the client

- Bytes flow back through Docker's forwarding to curl.
- **Client latency** = ①+②+③+…+⑨, always larger than server latency. The gap = network + queueing outside Node.

## Measuring the difference yourself

```bash
# client-side total time
curl -s -o /dev/null -w "client: %{time_total}s\n" "localhost:3003/api/latency?ms=100"

# server-side time (inside the response)
curl -s "localhost:3003/api/latency?ms=100"   # → "serverMs": 100.8
```

curl's `-w` can break the client time down further:

```bash
curl -s -o /dev/null -w "dns=%{time_namelookup} connect=%{time_connect} first_byte=%{time_starttransfer} total=%{time_total}\n" "localhost:3003/api/latency?ms=100"
```

- `connect`: TCP handshake done
- `first_byte` (TTFB): server finished processing and started responding
- `total − first_byte`: time to download the body (grows with payload size ÷ bandwidth, as in experiment 6)

## Failure scenarios summary

| Where | Failure | Client sees | HTTP |
|---|---|---|---|
| ① / ② | Container down or restarting | Connection refused | n/a (`000`) |
| ③ | Worker crashes mid-request | Connection reset / empty reply | n/a |
| ④ | Bad JSON body | Error JSON | 400 |
| ⑤ | Unknown path | Error JSON | 404 |
| ⑥ | Chaos failure | Error JSON | 500 |
| ⑥ | Chaos latency | Slow response | 200 |
| ⑦ | Invalid query param | Error JSON | 400 |
| ⑦ | Event loop blocked by CPU work | Very slow response, possible client timeout | 200 (late) |
| ⑦ | CAP, CP mode during partition | Error JSON | 503 |
