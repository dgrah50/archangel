/** Hard bound on daemon shutdown: under launchd's 20 s ExitTimeOut and the restart command's 30 s wait. */
export const SHUTDOWN_DEADLINE_MS = 15_000;

/**
 * Waits for in-flight work to settle, but never longer than the deadline. Returns true when it settled in time.
 * The caller releases the Ledger lock either way; leftover children and Sail boxes are swept by the next daemon.
 */
export async function settleWithin(work: Promise<unknown>, deadlineMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), deadlineMs);
  });
  try {
    return await Promise.race([work.then(() => true as const, () => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
