import { UserRateLimitGuard } from '../common/rate-limit/user-rate-limit.guard';

/** Per-user limits on /ask: every user shares one Gemini free-tier quota. */
export const AskRateLimitGuard = UserRateLimitGuard(
  'ask',
  'ASK_RATE_LIMIT_PER_MINUTE',
  'ASK_RATE_LIMIT_PER_DAY',
);
