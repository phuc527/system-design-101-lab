/**
 * Chaos engineering helper: lets you break the server on purpose.
 *
 * - failureRate:    probability (0..1) that an /api/* request returns HTTP 500
 * - extraLatencyMs: delay added to every /api/* request (a "slow dependency")
 *
 * Used to learn availability, reliability and fault tolerance by
 * measuring what clients experience when the server misbehaves.
 */
export interface ChaosSettings {
  failureRate: number;
  extraLatencyMs: number;
}

export class ChaosService {
  private settings: ChaosSettings;

  constructor(
    private readonly defaults: ChaosSettings,
    private readonly random: () => number = Math.random,
  ) {
    this.settings = { ...defaults };
  }

  get(): ChaosSettings {
    return { ...this.settings };
  }

  update(patch: Partial<ChaosSettings>): ChaosSettings {
    this.settings = { ...this.settings, ...patch };
    return this.get();
  }

  reset(): ChaosSettings {
    this.settings = { ...this.defaults };
    return this.get();
  }

  shouldFail(): boolean {
    return this.random() < this.settings.failureRate;
  }
}

/** Runtime validation for POST /chaos bodies (the compiler cannot check JSON from the network). */
export function parseChaosPatch(body: unknown): Partial<ChaosSettings> | string {
  if (typeof body !== "object" || body === null) return "Body must be a JSON object";
  const input = body as Record<string, unknown>;
  const patch: Partial<ChaosSettings> = {};

  if ("failureRate" in input) {
    const v = input["failureRate"];
    if (typeof v !== "number" || v < 0 || v > 1) return "failureRate must be a number between 0 and 1";
    patch.failureRate = v;
  }
  if ("extraLatencyMs" in input) {
    const v = input["extraLatencyMs"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 60_000) {
      return "extraLatencyMs must be an integer between 0 and 60000";
    }
    patch.extraLatencyMs = v;
  }
  if (Object.keys(patch).length === 0) return "Provide failureRate and/or extraLatencyMs";
  return patch;
}
