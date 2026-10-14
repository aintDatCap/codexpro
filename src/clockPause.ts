/**
 * Detect a large gap between event-loop turns, such as Windows S3 sleep/resume.
 * Date.now() alone must not expire idle MCP sessions while JavaScript cannot run.
 * A normal idle process continues polling and will still expire its old sessions.
 */
export class EventLoopPauseTracker {
  private previousCheck: number;

  constructor(
    private readonly now: () => number,
    private readonly expectedTickMs: number
  ) {
    this.previousCheck = now();
  }

  check(): number {
    const current = this.now();
    const elapsed = current - this.previousCheck;
    this.previousCheck = current;
    // Leave normal timer jitter, busy operations and clock adjustments alone.
    const threshold = Math.max(120_000, 3 * this.expectedTickMs);
    return Number.isFinite(elapsed) && elapsed > threshold ? elapsed : 0;
  }
}
