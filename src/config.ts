import { z } from 'zod';

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional; real env vars may already be set (e.g. in production)
}

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  PUBLIC_BASE_URL: z.string().url(),
  SILPO_MCP_URL: z.string().url().default('https://mcp.silpo.ua/mcp'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MAX_TOOL_CALLS_PER_TURN: z.coerce.number().int().positive().default(25),
  // Hard wall-clock budget for one agent turn (spec §8 Phase 6 item 4). The step cap alone cannot
  // bound a turn: a single MCP call that never answers would keep the user on a "typing" indicator
  // indefinitely, so runAgentTurn abandons the turn after this and replies with an apology.
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  PORT: z.coerce.number().int().positive().default(3000),
  AGENT_MODEL: z.string().default('claude-haiku-4-5'),
  // This is an ordering agent, not an open-ended chat companion — a real session (plan, resolve,
  // adjust once or twice, build cart) fits well under this. Caps token spend per user per day;
  // checked BEFORE any model or Silpo call, so hitting it costs nothing (see runAgentTurn.ts).
  DAILY_MESSAGE_LIMIT: z.coerce.number().int().positive().default(10),
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
