/**
 * Rate limits for the public "break something" buttons: one scenario at a time across everyone
 * (a global cooldown), and a small hourly allowance per client IP.
 */
export type Verdict = { ok: true } | { ok: false; retryAfterSeconds: number; reason: string };

export class BreakItLimiter {
  private lastGlobal = 0;
  private perIp = new Map<string, number[]>();

  constructor(
    private cooldownMs: number,
    private perIpPerHour: number,
  ) {}

  check(ip: string, now = Date.now()): Verdict {
    const wait = this.lastGlobal + this.cooldownMs - now;
    if (wait > 0) {
      return { ok: false, retryAfterSeconds: Math.ceil(wait / 1000), reason: "Another scenario is still playing out" };
    }
    const recent = (this.perIp.get(ip) ?? []).filter((t) => t > now - 3_600_000);
    if (recent.length >= this.perIpPerHour) {
      return {
        ok: false,
        retryAfterSeconds: Math.ceil((recent[0]! + 3_600_000 - now) / 1000),
        reason: "Hourly limit reached",
      };
    }
    return { ok: true };
  }

  record(ip: string, now = Date.now()) {
    this.lastGlobal = now;
    const recent = (this.perIp.get(ip) ?? []).filter((t) => t > now - 3_600_000);
    recent.push(now);
    this.perIp.set(ip, recent);
    if (this.perIp.size > 10_000) this.perIp.clear(); // bounded memory under abuse
  }
}
