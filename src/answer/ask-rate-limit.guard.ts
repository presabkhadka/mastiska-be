import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { RateLimiter, RateWindow } from '../common/rate-limit/rate-limiter';

/** Per-user limits on /ask: every user shares one Gemini free-tier quota. */
@Injectable()
export class AskRateLimitGuard implements CanActivate {
  private readonly windows: RateWindow[];

  constructor(
    private readonly limiter: RateLimiter,
    config: ConfigService,
  ) {
    this.windows = [
      {
        name: 'minute',
        limit: config.getOrThrow<number>('ASK_RATE_LIMIT_PER_MINUTE'),
        windowMs: 60_000,
      },
      {
        name: 'day',
        limit: config.getOrThrow<number>('ASK_RATE_LIMIT_PER_DAY'),
        windowMs: 86_400_000,
      },
    ];
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const user = http.getRequest<Request & { user?: AuthUser }>().user;
    if (!user) return true; // the global JWT guard has already rejected anonymous calls

    const decision = await this.limiter.consume(`ask:${user.id}`, this.windows);
    if (decision.allowed) return true;

    const retryAfter = Math.ceil(decision.retryAfterMs / 1000);
    http.getResponse<Response>().setHeader('Retry-After', String(retryAfter));
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: `Question limit per ${decision.window} reached; try again in ${retryAfter}s`,
        retryAfter,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
