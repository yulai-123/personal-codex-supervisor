import { asError } from "../shared/errors.js";
import type { Logger } from "./logger.js";

export type ComponentHealth = {
  component: string;
  status: "ok" | "degraded" | "failed";
  severity: "debug" | "info" | "notice" | "warning" | "error" | "critical";
  summary: string;
  metadata?: Record<string, unknown>;
};

export type RuntimeComponent = {
  name: string;
  start(signal: AbortSignal): Promise<void>;
  healthCheck?(): Promise<ComponentHealth> | ComponentHealth;
};

export type RunRuntimeComponentsOptions = {
  components: RuntimeComponent[];
  logger: Logger;
  signal?: AbortSignal;
};

export async function runRuntimeComponents(options: RunRuntimeComponentsOptions): Promise<void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await Promise.all(options.components.map((component) => runComponent(component, options.logger, controller)));
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function runComponent(
  component: RuntimeComponent,
  logger: Logger,
  controller: AbortController,
): Promise<void> {
  const componentLogger = logger.child({ component: component.name });
  componentLogger.info("component starting");
  try {
    await component.start(controller.signal);
    componentLogger.info("component stopped");
  } catch (error) {
    const err = asError(error);
    if (controller.signal.aborted) {
      componentLogger.warn("component stopped after abort", { error: err.message });
      return;
    }
    componentLogger.error("component failed", { error: err.message });
    controller.abort();
    throw err;
  }
}
