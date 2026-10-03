import { describe, expect, it } from "vitest";
import {
  availabilityReport,
  downtimeBudget,
  formatDuration,
  parallelAvailability,
  seriesAvailability,
} from "../src/services/availability.service.js";

describe("availability math", () => {
  it("series: every dependency lowers availability", () => {
    expect(seriesAvailability([0.999, 0.999, 0.999])).toBeCloseTo(0.997003, 6);
    expect(seriesAvailability([0.99, 0.5])).toBeCloseTo(0.495, 6);
  });

  it("parallel: redundancy raises availability", () => {
    expect(parallelAvailability(0.99, 1)).toBeCloseTo(0.99, 6);
    expect(parallelAvailability(0.99, 2)).toBeCloseTo(0.9999, 6);
    expect(parallelAvailability(0.9, 3)).toBeCloseTo(0.999, 6);
  });

  it("three nines allows ~8h 45m of downtime per year", () => {
    const budget = downtimeBudget(0.999);
    expect(budget.availabilityPercent).toBe(99.9);
    expect(budget.allowedDowntime.year).toBe("8h 45m");
    expect(budget.allowedDowntime.day).toBe("1m 26s");
  });

  it("formats durations", () => {
    expect(formatDuration(0.25)).toBe("250ms");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(3_661)).toBe("1h 1m");
    expect(formatDuration(90_000)).toBe("1d 1h");
  });

  it("builds a full report", () => {
    const report = availabilityReport(99, 2, 3);
    expect(report.single.availabilityPercent).toBe(99);
    expect(report.parallel.availabilityPercent).toBe(99.99);
    expect(report.series.availabilityPercent).toBeCloseTo(97.0299, 4);
    expect(report.nines).toHaveLength(5);
  });
});
