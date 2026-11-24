import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';

export interface RateWindow {
  name: string;
  limit: number;
  windowMs: number;
}

export type RateDecision =
  { allowed: true } | { allowed: false; window: string; retryAfterMs: number };

// Checks every window first and only then increments all of them, in one
// atomic step, so rejected requests don't use up quota.
const CONSUME = `
for i, key in ipairs(KEYS) do
  local count = tonumber(redis.call('GET', key) or '0')
  if count >= tonumber(ARGV[i * 2 - 1]) then return i end
end
for i, key in ipairs(KEYS) do
  if redis.call('INCR', key) == 1 then
    redis.call('PEXPIRE', key, ARGV[i * 2])
  end
end
return 0
`;

/** Fixed-window counters in Redis, shared by every app instance. */
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);

  constructor(private readonly redis: Redis) {}

  async consume(
    subject: string,
    windows: RateWindow[],
    now = Date.now(),
  ): Promise<RateDecision> {
    const active = windows.filter((w) => w.limit > 0);
    if (active.length === 0) return { allowed: true };

    const keys = active.map(
      (w) => `ratelimit:${subject}:${w.name}:${Math.floor(now / w.windowMs)}`,
    );
    const args = active.flatMap((w) => [w.limit, w.windowMs]);

    let blocked: number;
    try {
      blocked = Number(
        await this.redis.eval(CONSUME, keys.length, ...keys, ...args),
      );
    } catch (err) {
      // Fail open: a broken limiter shouldn't take the feature down.
      this.logger.warn(`Rate limiter unavailable: ${String(err)}`);
      return { allowed: true };
    }
    if (blocked === 0) return { allowed: true };

    const w = active[blocked - 1];
    const windowEnd = (Math.floor(now / w.windowMs) + 1) * w.windowMs;
    return { allowed: false, window: w.name, retryAfterMs: windowEnd - now };
  }
}
