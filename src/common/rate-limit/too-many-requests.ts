import { HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import type { RateDecision } from './rate-limiter';

/** 429 with a Retry-After header for a rejected rate-limit decision. */
export function tooManyRequests(
  res: Response,
  decision: Extract<RateDecision, { allowed: false }>,
): HttpException {
  const retryAfter = Math.ceil(decision.retryAfterMs / 1000);
  res.setHeader('Retry-After', String(retryAfter));
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message: `Limit per ${decision.window} reached; try again in ${retryAfter}s`,
      retryAfter,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
