import { z } from 'zod';

const configSchema = z.object({
  mode: z.enum(['paper', 'live']).default('paper'),
  port: z.coerce.number().int().min(1).max(65535).default(7777),
  dataDir: z.string().default('./data'),
  stateFile: z.string().default('./state/state.json'),
  journalDir: z.string().default('./journal'),
  alpaca: z.object({
    keyId: z.string(),
    secretKey: z.string(),
    tradingBaseUrl: z.string(),
    dataBaseUrl: z.string().default('https://data.alpaca.markets'),
  }),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file — fine; env vars may be set another way.
  }
  const env = process.env;
  const mode = env.THETAD_MODE === 'live' ? 'live' : 'paper';
  const isLive = mode === 'live';
  return configSchema.parse({
    mode,
    port: env.THETAD_PORT,
    dataDir: env.THETAD_DATA_DIR,
    stateFile: env.THETAD_STATE_FILE,
    journalDir: env.THETAD_JOURNAL_DIR,
    alpaca: {
      keyId: (isLive ? env.ALPACA_LIVE_KEY_ID : env.ALPACA_PAPER_KEY_ID) ?? '',
      secretKey: (isLive ? env.ALPACA_LIVE_SECRET_KEY : env.ALPACA_PAPER_SECRET_KEY) ?? '',
      tradingBaseUrl: isLive ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets',
    },
  });
}
