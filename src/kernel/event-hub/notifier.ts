type Waiter = {
  resolve: (result: WaitResult) => void;
  timer: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
};

export type WaitResult = "wake" | "timeout" | "aborted";

export class EventHubNotifier {
  private readonly waiters = new Map<string, Set<Waiter>>();

  wait(groupId: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    if (signal?.aborted) {
      return Promise.resolve("aborted");
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (result) => {
          this.removeWaiter(groupId, waiter);
          resolve(result);
        },
        timer: setTimeout(() => waiter.resolve("timeout"), timeoutMs),
      };

      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => waiter.resolve("aborted");
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      const groupWaiters = this.waiters.get(groupId) ?? new Set<Waiter>();
      groupWaiters.add(waiter);
      this.waiters.set(groupId, groupWaiters);
    });
  }

  wake(groupIds: string | string[]): void {
    const ids = Array.isArray(groupIds) ? groupIds : [groupIds];
    for (const groupId of ids) {
      const groupWaiters = this.waiters.get(groupId);
      if (!groupWaiters) {
        continue;
      }
      for (const waiter of [...groupWaiters]) {
        waiter.resolve("wake");
      }
    }
  }

  waiterCount(groupId?: string): number {
    if (groupId) {
      return this.waiters.get(groupId)?.size ?? 0;
    }
    return [...this.waiters.values()].reduce((count, group) => count + group.size, 0);
  }

  private removeWaiter(groupId: string, waiter: Waiter): void {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    const groupWaiters = this.waiters.get(groupId);
    if (!groupWaiters) {
      return;
    }
    groupWaiters.delete(waiter);
    if (groupWaiters.size === 0) {
      this.waiters.delete(groupId);
    }
  }
}
