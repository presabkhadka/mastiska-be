// Jest setupFile (test/jest-e2e.json): runs before AppModule reads its config.
// No per-user limits in tests; own queue prefix so a running dev server can't take test jobs.
process.env.ASSISTANT_RATE_LIMIT_PER_MINUTE = '0';
process.env.ASSISTANT_RATE_LIMIT_PER_DAY = '0';
process.env.REFRESH_RATE_LIMIT_PER_MINUTE = '0';
process.env.REFRESH_RATE_LIMIT_PER_DAY = '0';
process.env.QUEUE_PREFIX = 'bull-e2e';
// The embedder is faked in e2e, so the free-tier limiter would only slow tests down.
process.env.EMBED_JOBS_PER_MINUTE = '1000';
process.env.LOGIN_RATE_LIMIT_PER_IP_PER_MINUTE = '0';
process.env.LOGIN_RATE_LIMIT_PER_EMAIL_PER_15_MIN = '0';
process.env.REGISTER_RATE_LIMIT_PER_IP_PER_HOUR = '0';
