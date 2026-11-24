import Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('1h'),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .default('redis://localhost:6379'),
  // Optional until the embedding stage exists.
  GEMINI_API_KEY: Joi.string().allow('').default(''),
  EMBEDDING_MODEL: Joi.string().default('gemini-embedding-001'),
  // Fixed by the vector(768) column; changing it needs a migration + re-embed.
  EMBEDDING_DIMENSIONS: Joi.number().valid(768).default(768),
  ANSWER_MODEL: Joi.string().default('gemini-3.8-flash'),
  // Per user; 0 disables that window.
  ASK_RATE_LIMIT_PER_MINUTE: Joi.number().integer().min(0).default(5),
  ASK_RATE_LIMIT_PER_DAY: Joi.number().integer().min(0).default(50),
  ASSISTANT_RATE_LIMIT_PER_MINUTE: Joi.number().integer().min(0).default(5),
  ASSISTANT_RATE_LIMIT_PER_DAY: Joi.number().integer().min(0).default(50),
  // Auth abuse limits (0 disables). Behind a reverse proxy set TRUST_PROXY_HOPS so req.ip is the client.
  LOGIN_RATE_LIMIT_PER_IP_PER_MINUTE: Joi.number().integer().min(0).default(10),
  LOGIN_RATE_LIMIT_PER_EMAIL_PER_15_MIN: Joi.number()
    .integer()
    .min(0)
    .default(10),
  REGISTER_RATE_LIMIT_PER_IP_PER_HOUR: Joi.number().integer().min(0).default(5),
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).default(0),
  // Embed jobs per minute across all workers (Gemini free-tier quota).
  EMBED_JOBS_PER_MINUTE: Joi.number().integer().min(1).default(20),
  // Redis key prefix for BullMQ; e2e tests use their own so a running dev server can't take their jobs.
  QUEUE_PREFIX: Joi.string().default('bull'),
  // Scheduled re-fetch of auto-refresh bookmarks (cron in REFRESH_TIMEZONE).
  REFRESH_CRON: Joi.string().default('0 0,12 * * *'),
  REFRESH_TIMEZONE: Joi.string().default('Asia/Kathmandu'),
  REFRESH_MAX_PER_RUN: Joi.number().integer().min(1).default(500),
  REFRESH_MAX_PER_USER_PER_RUN: Joi.number().integer().min(1).default(20),
  REFRESH_RATE_LIMIT_PER_MINUTE: Joi.number().integer().min(0).default(5),
  REFRESH_RATE_LIMIT_PER_DAY: Joi.number().integer().min(0).default(50),
  // Comma-separated, tried in order when the previous model is overloaded,
  // rate-limited or times out; '' disables fallback.
  ANSWER_FALLBACK_MODELS: Joi.string()
    .allow('')
    .default('gemini-3.5-flash-lite,gemini-3.5-flash'),
});
