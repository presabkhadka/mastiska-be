import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { RateLimiter } from '../common/rate-limit/rate-limiter';
import { tooManyRequests } from '../common/rate-limit/too-many-requests';

const MINUTE = 60_000;
const QUARTER_HOUR = 15 * MINUTE;
const HOUR = 60 * MINUTE;

// Hashed so Redis keys don't hold email addresses.
const emailKey = (email: unknown) =>
  typeof email === 'string' && email.trim()
    ? createHash('sha256')
        .update(email.trim().toLowerCase())
        .digest('hex')
        .slice(0, 32)
    : null;

/**
 * Login: per IP (password guessing from one machine) and per email (guessing one
 * account from many IPs). The per-email window is short so an attacker can lock
 * someone out for at most 15 minutes.
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req =
      http.getRequest<Request<unknown, unknown, { email?: unknown }>>();
    const checks: [string, string, number, number][] = [
      [
        `login-ip:${req.ip}`,
        'minute',
        this.config.getOrThrow<number>('LOGIN_RATE_LIMIT_PER_IP_PER_MINUTE'),
        MINUTE,
      ],
    ];
    const email = emailKey(req.body?.email);
    if (email) {
      checks.push([
        `login-email:${email}`,
        '15 minutes',
        this.config.getOrThrow<number>('LOGIN_RATE_LIMIT_PER_EMAIL_PER_15_MIN'),
        QUARTER_HOUR,
      ]);
    }
    for (const [subject, name, limit, windowMs] of checks) {
      const decision = await this.limiter.consume(subject, [
        { name, limit, windowMs },
      ]);
      if (!decision.allowed) {
        throw tooManyRequests(http.getResponse<Response>(), decision);
      }
    }
    return true;
  }
}

/** Register: per IP, against mass account creation. */
@Injectable()
export class RegisterRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const decision = await this.limiter.consume(
      `register-ip:${http.getRequest<Request>().ip}`,
      [
        {
          name: 'hour',
          limit: this.config.getOrThrow<number>(
            'REGISTER_RATE_LIMIT_PER_IP_PER_HOUR',
          ),
          windowMs: HOUR,
        },
      ],
    );
    if (decision.allowed) return true;
    throw tooManyRequests(http.getResponse<Response>(), decision);
  }
}
