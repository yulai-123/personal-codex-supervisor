import type { AppDatabase } from "../../storage/sqlite.js";
import { asError } from "../../shared/errors.js";
import { createId } from "../../shared/ids.js";
import { ackDelivery, claimReadyDeliveries, failDelivery } from "./deliveries.js";
import type { EventHubNotifier } from "./notifier.js";
import type { ClaimedDelivery, ConsumerHandler } from "./types.js";

export type ConsumerRunnerOptions = {
  groupId: string;
  handler: ConsumerHandler;
  notifier: EventHubNotifier;
  fallbackScanMs: number;
  leaseMs: number;
  maxAttempts: number;
  batchSize?: number;
  workerId?: string;
};

export type ConsumerRunOnceResult = {
  claimed: number;
  acked: number;
  failed: number;
};

export async function runConsumerOnce(
  db: AppDatabase,
  options: Omit<ConsumerRunnerOptions, "notifier" | "fallbackScanMs">,
): Promise<ConsumerRunOnceResult> {
  const workerId = options.workerId ?? createId(`consumer_${options.groupId}`);
  const deliveries = claimReadyDeliveries(db, options.groupId, {
    limit: options.batchSize ?? 1,
    leaseMs: options.leaseMs,
    workerId,
  });

  let acked = 0;
  let failed = 0;
  for (const delivery of deliveries) {
    try {
      await options.handler(delivery);
      ackDelivery(db, delivery.delivery.id);
      acked += 1;
    } catch (error) {
      failDelivery(db, delivery.delivery.id, {
        error: asError(error),
        maxAttempts: options.maxAttempts,
      });
      failed += 1;
    }
  }

  return {
    claimed: deliveries.length,
    acked,
    failed,
  };
}

export async function runConsumerLoop(
  db: AppDatabase,
  options: ConsumerRunnerOptions,
  signal?: AbortSignal,
): Promise<void> {
  const workerId = options.workerId ?? createId(`consumer_${options.groupId}`);

  while (!signal?.aborted) {
    const result = await runConsumerOnce(db, {
      groupId: options.groupId,
      handler: options.handler,
      leaseMs: options.leaseMs,
      maxAttempts: options.maxAttempts,
      workerId,
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    });

    if (result.claimed === 0) {
      await options.notifier.wait(options.groupId, options.fallbackScanMs, signal);
    }
  }
}

export function collectMessageTypes(deliveries: ClaimedDelivery[]): string[] {
  return deliveries.map((delivery) => delivery.message.type);
}
