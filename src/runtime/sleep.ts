export function sleep(ms: number, signal?: AbortSignal): Promise<"timeout" | "aborted"> {
  if (signal?.aborted) {
    return Promise.resolve("aborted");
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("timeout");
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve("aborted");
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
