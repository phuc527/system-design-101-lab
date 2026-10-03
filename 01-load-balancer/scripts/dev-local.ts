/**
 * Run the whole lab WITHOUT Docker: 3 API instances + the TypeScript LB.
 *
 *   npm run dev
 *
 *   api1 -> http://localhost:3001
 *   api2 -> http://localhost:3002
 *   api3 -> http://localhost:3003
 *   lb   -> http://localhost:8091   (Nginx needs Docker: docker compose up)
 *
 * Ctrl+C stops everything.
 */
import { spawn, type ChildProcess } from "node:child_process";

interface Proc {
  name: string;
  script: string;
  env: Record<string, string>;
}

const procs: Proc[] = [
  { name: "api1", script: "src/api/server.ts", env: { PORT: "3001", INSTANCE_NAME: "api1", DRAIN_MS: "0" } },
  { name: "api2", script: "src/api/server.ts", env: { PORT: "3002", INSTANCE_NAME: "api2", DRAIN_MS: "0" } },
  { name: "api3", script: "src/api/server.ts", env: { PORT: "3003", INSTANCE_NAME: "api3", DRAIN_MS: "0" } },
  {
    name: "lb  ",
    script: "src/lb/server.ts",
    env: { LB_PORT: "8091", BACKENDS: "http://localhost:3001,http://localhost:3002,http://localhost:3003" },
  },
];

const children: ChildProcess[] = [];

for (const p of procs) {
  // `node --import tsx` runs TypeScript directly (no build step).
  const child = spawn(process.execPath, ["--import", "tsx", p.script], {
    env: { ...process.env, ...p.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = (chunk: Buffer): void => {
    for (const line of chunk.toString().split("\n")) if (line.trim()) console.log(`[${p.name}] ${line}`);
  };
  child.stdout?.on("data", prefix);
  child.stderr?.on("data", prefix);
  child.on("exit", (code) => console.log(`[${p.name}] exited with code ${code}`));
  children.push(child);
}

const stopAll = (): void => {
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
