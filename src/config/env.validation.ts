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
  // Comma-separated, tried in order when the previous model is overloaded,
  // rate-limited or times out; '' disables fallback.
  ANSWER_FALLBACK_MODELS: Joi.string()
    .allow('')
    .default('gemini-3.5-flash-lite,gemini-3.5-flash'),
});
