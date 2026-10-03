/**
 * Availability math - the numbers behind "three nines" and SLAs.
 *
 *   Availability = uptime / (uptime + downtime)
 *
 * Two rules you will use in every design interview:
 *
 *  SERIES (A needs B needs C - all must be up):
 *      A_total = A1 * A2 * A3            -> every dependency LOWERS availability
 *      99.9% * 99.9% * 99.9% = 99.7%
 *
 *  PARALLEL (N redundant replicas - at least one must be up):
 *      A_total = 1 - (1 - A)^N           -> redundancy RAISES availability
 *      two 99% replicas = 1 - 0.01^2 = 99.99%
 *
 * (Parallel assumes failures are independent. Two replicas in the same rack,
 *  on the same bad deploy, are NOT independent - a common interview trap.)
 */

const SECONDS = {
  year: 365.25 * 24 * 3600,
  month: (365.25 / 12) * 24 * 3600,
  week: 7 * 24 * 3600,
  day: 24 * 3600,
} as const;

export type Period = keyof typeof SECONDS;

export interface DowntimeBudget {
  availabilityPercent: number;
  allowedDowntime: Record<Period, string>;
}

export interface AvailabilityReport {
  single: DowntimeBudget;
  series: { dependencies: number } & DowntimeBudget;
  parallel: { replicas: number } & DowntimeBudget;
  nines: DowntimeBudget[];
}

/** 0.999 * 0.999 -> 0.998001. Inputs and output are fractions (0..1). */
export function seriesAvailability(components: readonly number[]): number {
  return components.reduce((acc, a) => acc * a, 1);
}

/** 1 - (1 - a)^replicas. Input and output are fractions (0..1). */
export function parallelAvailability(a: number, replicas: number): number {
  return 1 - Math.pow(1 - a, replicas);
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 1) return `${Math.round(totalSeconds * 1000)}ms`;
  const units: Array<[string, number]> = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1],
  ];
  const parts: string[] = [];
  let remaining = Math.round(totalSeconds);
  for (const [label, size] of units) {
    const amount = Math.floor(remaining / size);
    if (amount > 0) {
      parts.push(`${amount}${label}`);
      remaining -= amount * size;
    }
    if (parts.length === 2) break; // "8h 45m" is precise enough
  }
  return parts.join(" ") || "0s";
}

export function downtimeBudget(fraction: number): DowntimeBudget {
  const down = 1 - fraction;
  return {
    availabilityPercent: Math.round(fraction * 1e8) / 1e6,
    allowedDowntime: {
      year: formatDuration(SECONDS.year * down),
      month: formatDuration(SECONDS.month * down),
      week: formatDuration(SECONDS.week * down),
      day: formatDuration(SECONDS.day * down),
    },
  };
}

export function availabilityReport(percent: number, replicas: number, dependencies: number): AvailabilityReport {
  const a = percent / 100;
  return {
    single: downtimeBudget(a),
    series: { dependencies, ...downtimeBudget(seriesAvailability(Array<number>(dependencies).fill(a))) },
    parallel: { replicas, ...downtimeBudget(parallelAvailability(a, replicas)) },
    nines: [0.9, 0.99, 0.999, 0.9999, 0.99999].map(downtimeBudget),
  };
}
