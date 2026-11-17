// Starts the dashboard and the worker in one process.
import { AppDb } from './db.ts';
import { createWeb } from './web.ts';
import { tickAll, type Deps } from './engine.ts';
import { anthropicBatchClient } from './copy.ts';
import { googleAdsPort, type AdsPort } from './ads.ts';
import { TICK_SECONDS } from './config.ts';
import { log } from './log.ts';

const WEB_ENV = ['DATABASE_URL', 'APP_PASSWORD'];
const WORKER_ENV = ['ANTHROPIC_API_KEY', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN'];
const missing = (names: string[]) => names.filter((name) => !process.env[name]);
const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function main(): Promise<void> {
  // Wait for the variables instead of crashing, so the logs say what is missing.
  while (missing(WEB_ENV).length > 0) {
    log(`Waiting for variables: ${missing(WEB_ENV).join(', ')}`);
    await sleep(60);
  }
  const env = process.env as Record<string, string>;
  if (env.APP_PASSWORD.length < 12) {
    log('APP_PASSWORD must be at least 12 characters; refusing to start');
    process.exit(1);
  }
  const app = new AppDb(env.DATABASE_URL);
  await app.migrate();
  const port = Number(env.PORT ?? 3000);
  createWeb(app, { password: env.APP_PASSWORD, secret: env.SESSION_SECRET }).listen(port, () => log(`dashboard listening on port ${port}`));

  while (missing(WORKER_ENV).length > 0) {
    log(`Worker waiting for variables: ${missing(WORKER_ENV).join(', ')}`);
    await sleep(60);
  }
  const adsPorts = new Map<string, AdsPort>();
  const deps: Deps = {
    app,
    batches: anthropicBatchClient(env.ANTHROPIC_API_KEY),
    listsAccount: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    adsFor: (customerId) => {
      const cached = adsPorts.get(customerId);
      if (cached) return cached;
      const created = googleAdsPort(
        {
          developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
          clientId: env.GOOGLE_ADS_CLIENT_ID,
          clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
          refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
          loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
        },
        customerId,
      );
      adsPorts.set(customerId, created);
      return created;
    },
  };
  log('worker started');
  for (;;) {
    try {
      await tickAll(deps);
    } catch (error) {
      log(`worker error: ${(error as Error).stack ?? error}`);
    }
    await sleep(TICK_SECONDS);
  }
}

main().catch((error) => {
  log(`fatal: ${(error as Error).stack ?? error}`);
  process.exit(1);
});
