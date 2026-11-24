import type Redis from 'ioredis';
import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  const evalMock = jest.fn();
  const limiter = new RateLimiter({ eval: evalMock } as unknown as Redis);
  const windows = [
    { name: 'minute', limit: 5, windowMs: 60_000 },
    { name: 'day', limit: 50, windowMs: 86_400_000 },
  ];
  const now = Date.UTC(2026, 10, 24, 12, 0, 45); // 45s into a minute

  beforeEach(() => evalMock.mockReset());

  it('keys each window by its current bucket and passes limits', async () => {
    evalMock.mockResolvedValue(0);
    await expect(limiter.consume('ask:u1', windows, now)).resolves.toEqual({
      allowed: true,
    });
    const [, numKeys, ...rest] = evalMock.mock.calls[0] as unknown[];
    expect(numKeys).toBe(2);
    expect(rest).toEqual([
      `ratelimit:ask:u1:minute:${Math.floor(now / 60_000)}`,
      `ratelimit:ask:u1:day:${Math.floor(now / 86_400_000)}`,
      5,
      60_000,
      50,
      86_400_000,
    ]);
  });

  it('reports which window blocked and when it resets', async () => {
    evalMock.mockResolvedValue(1);
    await expect(limiter.consume('ask:u1', windows, now)).resolves.toEqual({
      allowed: false,
      window: 'minute',
      retryAfterMs: 15_000,
    });
  });

  it('skips disabled windows and never calls Redis when all are off', async () => {
    const off = windows.map((w) => ({ ...w, limit: 0 }));
    await expect(limiter.consume('ask:u1', off, now)).resolves.toEqual({
      allowed: true,
    });
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('fails open when Redis is unavailable', async () => {
    evalMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(limiter.consume('ask:u1', windows, now)).resolves.toEqual({
      allowed: true,
    });
  });
});
