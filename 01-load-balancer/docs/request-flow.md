# Request Flow

Follow `GET /work?ms=100` from your terminal through Nginx to api2 and back.

```text
curl ──① TCP + HTTP──▶ Docker port 8090 ──② ──▶ nginx worker
                                                  │ ③ pick backend (strategy, healthy only)
                                                  │ ④ rewrite headers
                                                  │ ⑤ reuse keep-alive connection
                                                  ▼
                                                api2 :3000
                                                  │ ⑥ trackRequest, chaos, pool.acquire, "query"
                                                  ▼
                                                nginx
                                                  │ ⑦ success → stream back
                                                  │   failure → passive check, maybe retry on api3
                                                  │ ⑧ add X-Upstream-*, write access log
                                                  ▼
curl ◀──────────── 200 + X-Instance: api2 + X-Upstream-Addr: 172.18.0.5:3000
```

## ① Client → host port

`curl localhost:8090` opens a TCP connection to Docker's published port.
**Failure:** port not published or held by another program (we hit an Apache on 8080) → connection refused or a different server answers.

## ② Docker → nginx container

Docker forwards to the container's port 80. One of Nginx's worker processes accepts the connection. Each worker is single-threaded and event-driven, like Node.

## ③ Pick a backend

The `upstream api_backend` block decides:
- **round-robin:** next in turn
- **least-conn:** fewest active connections
- **ip-hash / hash:** hash of client IP / `X-User-Id`
- **weighted:** proportional to `weight=`

Servers that failed `max_fails=2` times within `fail_timeout=10s` are skipped for 10s. Servers whose DNS name no longer resolves (container stopped) aren't in the list at all (`resolve`).
**Failure:** no live servers → **502** `no live upstreams`, instantly.

## ④ Rewrite headers

```nginx
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;               # 172.18.0.1 (Docker gateway)
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for; # appends client IP to any existing list
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Connection        "";                         # allow upstream keep-alive
```

Without these, api2 would see every request coming from Nginx's IP, and IP-based logs and rate limits would break.

## ⑤ Upstream connection

`keepalive 32` + HTTP/1.1 means Nginx reuses an idle TCP connection to api2 if it has one. Otherwise it connects, and if that takes longer than `proxy_connect_timeout 1s` → failure.
**Failures:** `connection refused` (process dead, instant), `connect timeout` (host gone, 1s), `connection reset` (process died mid-request).

## ⑥ Backend processing (api2)

1. `trackRequest`: `inFlight++`, set `X-Instance: api2`
2. `chaos`: maybe sleep (slow), maybe 500 (error)
3. `pool.acquire()`: wait for 1 of 10 "DB connections". Under overload this is where requests queue (`queuedMs`)
4. `sleep(100)`: the "query"
5. `release()`, respond JSON

**Failures:** chaos 500, slow responses, the process hangs (paused) → no bytes ever arrive.

## ⑦ Response or retry

| What happened | Nginx does |
|---|---|
| 2xx/3xx/4xx | stream it to the client |
| `error` (refused/reset) or `timeout` (connect 1s / read 5s) | count a failure for api2, **retry on next server** (GET), at most 2 tries total within 6s |
| 500/502/503/504 | same as above (because of `proxy_next_upstream http_500 ...`) |
| POST that failed after being sent | **no retry**, error returned to client (non-idempotent) |
| all tries failed | 502 (error) or 504 (timeout) |

The TS LB does the same in [src/lb/balancer.ts](../src/lb/balancer.ts), retrying GET/HEAD once.

## ⑧ Log + debug headers

```json
{"time":"...","client":"172.18.0.1","request":"GET /work?ms=100","status":200,
 "upstream":"172.18.0.5:3000","upstream_status":"200","request_time":0.104,"upstream_response_time":"0.104"}
```

With a retry, you'll see both attempts: `"upstream":"172.18.0.3:3000, 172.18.0.4:3000"` and `"upstream_status":"504, 200"`.

```bash
docker compose logs -f nginx       # watch decisions live
curl -s -i localhost:8090/ | grep -i x-upstream
```

## Timing: where do the milliseconds go?

```bash
curl -s -o /dev/null -w "connect=%{time_connect} ttfb=%{time_starttransfer} total=%{time_total}\n" "localhost:8090/work?ms=100"
docker compose logs nginx --tail 1   # compare request_time vs upstream_response_time
```

- `upstream_response_time`: time api2 took (≈ 0.100 + queueing)
- `request_time - upstream_response_time`: Nginx's own overhead (usually < 1ms)
- `curl total - request_time`: network between you and Nginx (Docker Desktop forwarding)

## Failure summary

| Step | Failure | User sees |
|---|---|---|
| ① | port conflict / LB down | connection refused, or the wrong server |
| ③ | all backends marked down | 502 immediately |
| ⑤ | backend dead | nothing (retried), small latency increase |
| ⑤/⑥ | backend hung | waits up to `proxy_read_timeout`, then retried |
| ⑥ | backend 500 | nothing for GET (retried). Error for POST |
| ⑥ | backend overloaded | high latency (queueing in the pool) |
| ⑦ | every retry failed | 502 / 504 |
