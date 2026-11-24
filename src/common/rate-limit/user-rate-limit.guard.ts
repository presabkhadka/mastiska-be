import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  mixin,
  Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../auth/decorators/current-user.decorator';
import { RateLimiter, RateWindow } from './rate-limiter';

/**
 * Per-user minute/day limits for an expensive endpoint.
 * `minuteEnv`/`dayEnv` name the config keys holding the limits (0 disables).
 */
export function UserRateLimitGuard(
  prefix: string,
  minuteEnv: string,
  dayEnv: string,
): Type<CanActivate> {
  @Injectable()
  class Guard implements CanActivate {
    private readonly windows: RateWindow[];

    constructor(
      private readonly limiter: RateLimiter,
      config: ConfigService,
    ) {
      this.windows = [
        {
          name: 'minute',
          limit: config.getOrThrow<number>(minuteEnv),
          windowMs: 60_000,
        },
        {
          name: 'day',
          limit: config.getOrThrow<number>(dayEnv),
          windowMs: 86_400_000,
        },
      ];
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const http = context.switchToHttp();
      const user = http.getRequest<Request & { user?: AuthUser }>().user;
      if (!user) return true; // the global JWT guard has already rejected anonymous calls

      const decision = await this.limiter.consume(
        `${prefix}:${user.id}`,
        this.windows,
      );
      if (decision.allowed) return true;

      const retryAfter = Math.ceil(decision.retryAfterMs / 1000);
      http.getResponse<Response>().setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: `Limit per ${decision.window} reached; try again in ${retryAfter}s`,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
  return mixin(Guard);
}
