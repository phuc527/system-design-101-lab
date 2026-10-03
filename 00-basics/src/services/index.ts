import type { AppConfig } from "../config/index.js";
import { CapCluster } from "./cap.service.js";
import { ChaosService } from "./chaos.service.js";
import { RuntimeService } from "./runtime.service.js";
import { StatsService } from "./stats.service.js";

/**
 * Everything the controllers need, created in one place.
 * Plain constructor injection - no DI framework. Tests can pass their own
 * instances (e.g. a ChaosService with a fake random()) to createApp().
 */
export interface Services {
  config: AppConfig;
  stats: StatsService;
  runtime: RuntimeService;
  chaos: ChaosService;
  cap: CapCluster;
}

export function createServices(config: AppConfig): Services {
  return {
    config,
    stats: new StatsService(),
    runtime: new RuntimeService(),
    chaos: new ChaosService({ ...config.chaos }),
    cap: new CapCluster(),
  };
}
