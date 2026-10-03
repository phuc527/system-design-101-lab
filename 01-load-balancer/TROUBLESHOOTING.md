# Troubleshooting: Lab 01

Commands for **Git Bash** on Windows (also macOS/Linux). PowerShell alternatives where they differ.

---

## Port already in use, or "it works with curl but not with k6"

**Symptoms:** `Bind for 0.0.0.0:8090 failed: port is already allocated`. Or worse: `curl localhost:PORT` reaches Nginx but another tool gets 404s or a different server.

That second one happened while building this lab. An Apache `httpd` held `0.0.0.0:8080` (IPv4), and Docker could only bind `[::]:8080` (IPv6). `curl localhost` resolved to `::1` (IPv6) and reached Nginx, while k6 via `host.docker.internal` (IPv4) reached Apache: 100% 404s. That's why this lab uses 8090/8091.

```powershell
# PowerShell: who listens on a port, on which address family?
Get-NetTCPConnection -LocalPort 8090 -State Listen | Select LocalAddress, OwningProcess, @{n='Process';e={(Get-Process -Id $_.OwningProcess).ProcessName}}
```
```bash
netstat -ano | grep ":8090 "                       # Git Bash
docker compose ps --format "table {{.Service}}\t{{.Ports}}"   # should show 0.0.0.0:8090 AND [::]:8090
docker compose exec node-lb wget -qO- http://host.docker.internal:8090/lb-health   # test the IPv4 path from a container
```
**Fix:** stop the other program, or change the host port in `docker-compose.yml` (`"8090:80"` → `"8095:80"`).

## Nginx keeps sending traffic to a stopped container

**Symptoms:** after `docker compose stop api2`, some requests are slow (≈1s+) or show `upstream timed out ... while connecting` with an old IP. Nginx logs `api2 could not be resolved (110: Operation timed out)`.

**Cause:** Nginx re-resolves names via Docker DNS (`resolve`). If the DNS answer for a missing name (NXDOMAIN) takes longer than `resolver_timeout`, Nginx treats it as a temporary error and **keeps the old IP**. On Docker Desktop this took ~3.8s.

```bash
docker compose exec nginx sh -c 'time nslookup -type=a api2 127.0.0.11'   # how long does NXDOMAIN take?
docker compose logs nginx | grep "could not be resolved" | tail -3
```
**Fix:** `resolver_timeout 10s;` (already set in [nginx/nginx.conf](nginx/nginx.conf)). "(3: Host not found)" is the *good* message: Nginx received NXDOMAIN and removed the server.

## Nginx returns 502 "no live upstreams"

```bash
docker compose ps                                   # are api1-3 running and healthy?
docker compose logs nginx | grep "\[error\]" | tail -5
for i in 1 2 3; do curl -s localhost:300$i/health; echo; done
```
- All backends failed `max_fails` within `fail_timeout` → Nginx skips them for 10s. Fix the backends (chaos mode? `curl -s localhost:3001/admin/chaos`), then wait 10s.
- Backends running but unreachable from Nginx: check they're on the same network: `docker network inspect sd101-lb_default`.

## Nginx returns 504 Gateway Timeout

A backend accepted the connection but didn't answer within `proxy_read_timeout` (5s). Usually a slow or paused instance:
```bash
docker compose ps                    # "Paused"?  → docker compose unpause api2
for i in 1 2 3; do curl -s localhost:300$i/admin/chaos; echo; done   # mode "slow"?
```

## Nginx won't start / config errors

```bash
docker compose logs nginx | tail -20
docker compose run --rm --no-deps nginx nginx -t        # test the config
```
- `open() "/etc/nginx/upstreams/xyz.conf" failed`: invalid `NGINX_STRATEGY`. Valid values: `round-robin least-conn ip-hash weighted hash`.
- `host not found in upstream`: a server line without `resolve` pointing at a container that isn't running.
- Edited a config file? Recreate: `docker compose up -d --force-recreate --no-deps nginx`.

## Strategy switch didn't take effect

```bash
curl -s localhost:8090/lb-health                  # shows the active strategy
NGINX_STRATEGY=least-conn docker compose up -d --no-deps nginx
```
The variable must be set **on the same command line** (or exported, or in a `.env` file next to `docker-compose.yml`). PowerShell: `$env:NGINX_STRATEGY="least-conn"; docker compose up -d --no-deps nginx`.

## The TypeScript LB returns 503 NO_HEALTHY_BACKENDS

```bash
curl -s localhost:8091/lb/status        # lastError of each backend tells you why
docker compose logs node-lb | grep -E "DOWN|UP" | tail -5
```
Backends come back only after `HEALTHY_THRESHOLD` (2) successful active checks, about 4s after they recover.

## A container exits with code 137 during `docker compose stop`

137 = 128 + 9 = **SIGKILL**: the process didn't exit within the stop grace period.
```bash
docker inspect sd101-lb-api2-1 --format 'exit={{.State.ExitCode}} StopTimeout={{.Config.StopTimeout}}'
docker compose logs api2 | tail -5      # did it reach "all connections closed, exiting"?
```
Make sure `stop_grace_period` (15s) > `DRAIN_MS` (6s) + longest request. On the machine this lab was built on, the default was only 3s.

## Deploys/stops cause errors

Check the timing rule: **LB detection time < DRAIN_MS < stop_grace_period**. With the TS LB, detection ≈ `HEALTH_CHECK_INTERVAL_MS × UNHEALTHY_THRESHOLD` + one interval ≈ 4–6s. See experiment 11.

## Distribution looks uneven

| Pattern | Likely cause |
|---|---|
| 100% to one instance | `ip-hash` strategy (all your requests share one IP), or other instances stopped/down |
| Uneven with `hash` | few distinct users, so consistent hashing isn't uniform for small key counts |
| Uneven with `least-conn` | expected when one instance is slower |
| One instance missing | it's down: check `docker compose ps` and `curl localhost:300X/health` |

## Benchmarks: adding instances doesn't increase throughput

- Using `/cpu`? On a laptop, containers share one physical CPU, which may throttle (experiment 3). Use `/work?ms=100` to see per-instance capacity scaling.
- Did Nginx pick up the new instance? `npm run dist -- --n 30` should show it. Wait ~10s after `docker compose start`.
- Is the load generator the bottleneck? Raise `-c`, close other apps.

## `npm run dev` leaves processes behind

Ctrl+C in the terminal stops all four processes. If the parent was killed some other way, the children keep ports 3001–3003/8091:
```powershell
Get-NetTCPConnection -LocalPort 3001,3002,3003,8091 -State Listen | Select LocalPort, OwningProcess
Stop-Process -Id <PID>
```

## Docker container cannot connect to another container

Containers reach each other by **service name** (`http://api1:3000`), never `localhost` (inside a container, `localhost` is the container itself).
```bash
docker compose exec node-lb wget -qO- http://api1:3000/health
docker compose exec nginx nslookup api1 127.0.0.11
```

## TypeScript build failed

```bash
npm run build          # src only
npm run typecheck      # src + tests + scripts
```
Under `NodeNext`, relative imports need `.js` (`import { x } from "./x.js"`). Strict flags: `noUncheckedIndexedAccess` means array access returns `T | undefined`, so handle it with `?? fallback` or `!` only when the index is guaranteed.

## Environment variable missing or invalid

The TS LB validates config at startup:
```text
ConfigError: LB_STRATEGY must be one of round-robin, least-connections, ip-hash, random, got "fastest"
ConfigError: BACKENDS contains an invalid URL: "api1:3000" (expected http://host:port)
```
```bash
docker compose exec node-lb env | grep -E "BACKENDS|LB_|HEALTH"
```
