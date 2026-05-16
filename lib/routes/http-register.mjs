import { registerCoreApi } from './core-api.mjs';
import { registerAdvisorApi } from './advisor-api.mjs';
import { registerFeatureDesignerApi } from './feature-designer-api.mjs';
import { registerFlightEngineerApi } from './flight-engineer-api.mjs';
import { registerSimLabApi } from './sim-lab-api.mjs';

/** Why: split core (telemetry, flights, connections, …) from advisor (chat, issues, apply, audit) from feature-designer. */
export function registerHttpRoutes(app, ctx) {
  registerCoreApi(app, ctx);
  registerAdvisorApi(app, ctx);
  registerFeatureDesignerApi(app, ctx);
  registerFlightEngineerApi(app, ctx);
  registerSimLabApi(app, ctx);
}
