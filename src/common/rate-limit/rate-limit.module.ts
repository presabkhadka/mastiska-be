import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RateLimiter } from './rate-limiter';

export const RATE_LIMIT_REDIS = Symbol('RATE_LIMIT_REDIS');

@Module({
  providers: [
    {
      provide: RATE_LIMIT_REDIS,
      inject: [ConfigService],
      // Fail fast instead of queueing commands while Redis is down.
      useFactory: (config: ConfigService) =>
        new Redis(config.getOrThrow<string>('REDIS_URL'), {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        }),
    },
    {
      provide: RateLimiter,
      inject: [RATE_LIMIT_REDIS],
      useFactory: (redis: Redis) => new RateLimiter(redis),
    },
  ],
  exports: [RateLimiter],
})
export class RateLimitModule implements OnModuleDestroy {
  constructor(@Inject(RATE_LIMIT_REDIS) private readonly redis: Redis) {}

  async onModuleDestroy() {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
