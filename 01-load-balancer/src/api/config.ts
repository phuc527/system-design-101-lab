import os from "node:os";
import { readNumber, readString } from "../shared/env.js";

export interface ApiConfig {
  readonly port: number;
  /** Shown in every response so you can see which instance answered. */
  readonly instanceName: string;
  readonly maxCpuN: number;
  /** Size of the simulated resource pool used by /work (think: DB connection pool). */
  readonly poolSize: number;
}

export function loadApiConfig(): ApiConfig {
  return Object.freeze({
    port: readNumber("PORT", 3000, 1, 65535),
    instanceName: readString("INSTANCE_NAME", os.hostname()),
    maxCpuN: readNumber("MAX_CPU_N", 40, 1, 45),
    poolSize: readNumber("POOL_SIZE", 10, 1, 10_000),
  });
}
