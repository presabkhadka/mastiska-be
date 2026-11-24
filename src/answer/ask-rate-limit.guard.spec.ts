import { ExecutionContext, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimiter } from '../common/rate-limit/rate-limiter';
import { AskRateLimitGuard } from './ask-rate-limit.guard';

describe('AskRateLimitGuard', () => {
  const consume = jest.fn();
  const setHeader = jest.fn();
  const config = {
    getOrThrow: (k: string) => (k.endsWith('MINUTE') ? 5 : 50),
  } as unknown as ConfigService;
  const guard = new AskRateLimitGuard(
    { consume } as unknown as RateLimiter,
    config,
  );
  const ctx = (user?: { id: string }) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user }),
        getResponse: () => ({ setHeader }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    consume.mockReset();
    setHeader.mockReset();
  });

  it('counts per user with minute and day windows', async () => {
    consume.mockResolvedValue({ allowed: true });
    await expect(guard.canActivate(ctx({ id: 'u1' }))).resolves.toBe(true);
    expect(consume).toHaveBeenCalledWith('ask:u1', [
      { name: 'minute', limit: 5, windowMs: 60_000 },
      { name: 'day', limit: 50, windowMs: 86_400_000 },
    ]);
  });

  it('returns 429 with Retry-After when the limit is hit', async () => {
    consume.mockResolvedValue({
      allowed: false,
      window: 'minute',
      retryAfterMs: 14_200,
    });
    const err = await guard
      .canActivate(ctx({ id: 'u1' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '15');
  });
});
