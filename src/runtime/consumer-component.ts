import type { AppDatabase } from "../storage/sqlite.js";
import { runConsumerLoop, type ConsumerRunnerOptions } from "../kernel/event-hub/consumer-runner.js";
import type { RuntimeComponent } from "./component.js";

export type ConsumerComponentOptions = Omit<ConsumerRunnerOptions, "workerId"> & {
  workerId: string;
};

export function createConsumerComponent(
  db: AppDatabase,
  options: ConsumerComponentOptions,
): RuntimeComponent {
  return {
    name: options.workerId,
    start: (signal) => runConsumerLoop(db, options, signal),
  };
}
