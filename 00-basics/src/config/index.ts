import os from "node:os";

/**
 * Typed configuration.
 *
 * Every value is read from environment variables ONCE at startup, validated,
 * and frozen. The rest of the app imports `config` and never touches
 * `process.env` directly - that keeps configuration errors loud and early
 * instead of surfacing as weird behaviour at 3am.
 */
export interface AppConfig {
  readonly port: number;
  readonly instanceName: string;
  readonly workers: number;
  readonly chaos: {
    readonly failureRate: number;
    readonly extraLatencyMs: number;
  };
  readonly limits: {
    readonly maxCpuN: number;
    readonly maxPayloadKb: number;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a number between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const requestedWorkers = readNumber("WORKERS", 1, 0, 64);

  return Object.freeze({
    port: readNumber("PORT", 3000, 1, 65535),
    instanceName: process.env["INSTANCE_NAME"] ?? os.hostname(),
    // WORKERS=0 means "one worker per CPU core"
    workers: requestedWorkers === 0 ? os.availableParallelism() : requestedWorkers,
    chaos: Object.freeze({
      failureRate: readNumber("CHAOS_FAILURE_RATE", 0, 0, 1),
      extraLatencyMs: readNumber("CHAOS_EXTRA_LATENCY_MS", 0, 0, 60_000),
    }),
    limits: Object.freeze({
      maxCpuN: readNumber("MAX_CPU_N", 42, 1, 50),
      maxPayloadKb: readNumber("MAX_PAYLOAD_KB", 10_240, 1, 102_400),
    }),
  });
}

export const config: AppConfig = loadConfig();
