# Troubleshooting: Lab 00

Commands are for **Git Bash** on Windows (also work on macOS/Linux). PowerShell equivalents are given where they differ.

---

## Port already in use

**Symptom:** `Error: listen EADDRINUSE: address already in use :::3000` or Docker says `Bind for 0.0.0.0:3001 failed: port is already allocated`.

**Diagnose: who owns the port?**
```bash
# Windows (Git Bash or PowerShell)
netstat -ano | grep ":3000 "          # last column = PID   (PowerShell: netstat -ano | findstr :3000)
tasklist //FI "PID eq <PID>"           # what program is it  (PowerShell: tasklist /FI "PID eq <PID>")

# macOS / Linux
lsof -i :3000

# Is it one of our containers?
docker ps --format "table {{.Names}}\t{{.Ports}}"
```

**Fix:**
```bash
taskkill //F //PID <PID>               # Windows (PowerShell: taskkill /F /PID <PID>)
kill <PID>                             # macOS / Linux
PORT=3100 npm run dev                  # or just use another port
docker compose down                    # if an old run of this lab still holds 3001-3003
```
To change the host port in Docker, edit `ports: - "3001:3000"` → `"4001:3000"` in `docker-compose.yml`.

## Docker daemon not running

**Symptom:** `Cannot connect to the Docker daemon` / `error during connect: ... dockerDesktopLinuxEngine`.

```bash
docker info          # fails if the daemon is down
```
**Fix:** start Docker Desktop and wait until it says "Engine running", then retry.

## Container is "unhealthy" or keeps restarting

```bash
docker compose ps                                   # STATUS column: (healthy) / (unhealthy) / Restarting
docker compose logs api-baseline --tail 50          # look for errors at startup
docker inspect sd101-basics-api-baseline-1 --format '{{json .State.Health}}'   # last healthcheck outputs
docker inspect sd101-basics-api-baseline-1 --format 'RestartCount={{.RestartCount}} OOMKilled={{.State.OOMKilled}}'
```

Common causes:
| Cause | Clue | Fix |
|---|---|---|
| Bad env var | log shows `ConfigError: WORKERS must be a number...` | fix the value in `docker-compose.yml` |
| Event loop blocked by `/api/cpu` load | healthcheck timeouts only during benchmarks | expected! (experiment 4). Lower `n` or concurrency |
| Out of memory | `OOMKilled=true` | lower `kb` in `/api/payload`, or raise `memory:` limit |
| You called `/chaos/crash` | `crash requested` in logs | expected (experiment 9) |

## Docker container cannot connect / curl returns nothing

**Symptom:** `curl: (7) Failed to connect to localhost port 3001` or `curl: (52) Empty reply from server`.

```bash
docker compose ps                         # is it running and are ports mapped? (0.0.0.0:3001->3000/tcp)
docker compose logs api-baseline --tail 20
docker compose exec api-baseline wget -qO- http://127.0.0.1:3000/health   # test from INSIDE the container
```
- Works inside but not outside → port mapping problem (check `ports:`), or a firewall/VPN intercepting localhost.
- Fails inside too → the app isn't listening. Check logs.
- `(52) Empty reply` right after `/chaos/crash` → the process died mid-request. Wait 2–3s.

## k6 container can't reach the API

**Symptom:** k6 shows `dial tcp: lookup host.docker.internal: no such host` or connection refused.

- Docker Desktop (Windows/macOS): `host.docker.internal` works by default. Make sure the target container is up: `curl localhost:3001/health`.
- Linux: add `--add-host=host.docker.internal:host-gateway` to `docker run`.
- PowerShell doesn't support `< file` redirection the same way. Use: `Get-Content k6/load-test.js | docker run --rm -i -e BASE_URL=http://host.docker.internal:3001 grafana/k6 run -`

## Benchmark numbers look wrong or very noisy

- **The load generator competes with the server.** autocannon/k6 on the same laptop steal CPU. Close other apps and treat numbers as *relative*, not absolute.
- **Warm-up.** The first seconds include JIT compilation. Run each benchmark twice and use the second result.
- **Laptop power mode.** Battery saver throttles CPU. Plug in and pick a high-performance power plan.
- **Previous experiment still affecting results.** Check `curl -s localhost:3001/chaos`, then `curl -s -X POST localhost:3001/chaos/reset` and `curl -s -X POST localhost:3001/metrics/reset`.
- **Horizontal scaling shows < 2×.** That's expected on laptops (hyperthreads, turbo limits). See experiment 5.

## `/metrics` numbers jump around between calls

You're hitting `api-horizontal` (port 3003) or `WORKERS>1`. Each worker process has its own in-memory stats, and the `pid` field shows which one answered. That's the lesson, not a bug (see "Bottlenecks" in README). Use a single-process instance (3001/3002) for consistent numbers.

## `POST /chaos` doesn't seem to apply everywhere

Same cause: in cluster mode the request reaches **one** worker. Send it several times (check the `pid` in each response), or use a single-process instance.

## CAP simulator state "resets" or behaves randomly

You're on port 3003 (cluster). Each worker has its own simulated cluster. Use 3001 or 3002. Reset with `curl -s -X POST localhost:3002/cap/reset`.

## TypeScript build failed

```bash
npm run build          # compile src/ only
npm run typecheck      # src + tests + scripts, shows every error
npx tsc --version      # expect 7.x (from node_modules, not a global install)
```
Common errors with strict settings:
| Error | Meaning | Fix |
|---|---|---|
| `Object is possibly 'undefined'` on `arr[i]` | `noUncheckedIndexedAccess`: array reads may be undefined | `arr[i] ?? fallback`, or check first |
| `Type 'undefined' is not assignable ... exactOptionalPropertyTypes` | optional props can't be set to `undefined` explicitly | omit the property instead of `prop: undefined` |
| `Cannot find module '../x.js'` | relative imports need the `.js` extension under `NodeNext` | `import { a } from "./a.js"` (even though the file is `a.ts`) |
| `Cannot find name 'process'` | Node types missing | `npm install` (installs `@types/node`) |

If `node_modules` is corrupted: `rm -rf node_modules && npm ci`.

## Tests fail

```bash
npm test -- --reporter=verbose        # see every test name and failure
npx vitest run tests/cap.test.ts      # run one file
```
Timing tests (`sequential vs parallel`, `throttled download`) can flake on a heavily loaded machine. Re-run once, and if it persists check that nothing CPU-heavy is running.

## Environment variable missing or ignored

- `npm run dev` does **not** load `.env` automatically. Pass vars inline: `WORKERS=2 PORT=3100 npm run dev` (PowerShell: `$env:WORKERS=2; npm run dev`).
- Invalid values fail fast at startup:
  ```text
  ConfigError: CHAOS_FAILURE_RATE must be a number between 0 and 1, got "20"
  ```
- Check what a container actually received: `docker compose exec api-baseline env | sort`.

## `npm install` warnings about vulnerabilities

`npm audit` may report moderate issues in dev-only tools (autocannon's dependency tree). They don't ship in the Docker image (`npm prune --omit=dev`). Inspect with `npm audit --omit=dev`, which should report 0 for production dependencies.
