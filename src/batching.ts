export interface BatchWindow {
  firstReceivedAt: Date;
  lastReceivedAt: Date;
}

export function nextProcessAfter(
  window: BatchWindow,
  idleMs: number,
  maxWaitMs: number
): Date {
  const idleDeadline = window.lastReceivedAt.getTime() + idleMs;
  const maximumDeadline = window.firstReceivedAt.getTime() + maxWaitMs;
  return new Date(Math.min(idleDeadline, maximumDeadline));
}

export function shouldStartNewBatch(pendingMessageCount: number, messageLimit: number): boolean {
  return pendingMessageCount >= messageLimit;
}

export function retryDelayMs(attempt: number): number {
  const boundedAttempt = Math.max(1, Math.min(attempt, 8));
  return Math.min(60_000 * 2 ** (boundedAttempt - 1), 60 * 60_000);
}
