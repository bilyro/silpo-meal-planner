import { pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './client.js';
import { logger } from '../logger.js';

/**
 * Applies every pending migration in `drizzle/`.
 *
 * Idempotent — drizzle records what it has applied in its own `__drizzle_migrations` table — so it
 * is safe to call on every boot, which is what `src/index.ts` does. That keeps a cold start on a
 * fresh database working with no separate release command, which matters because the deploy target
 * is a single container (spec §8 Phase 7 item 1).
 *
 * Single-instance assumption: two containers booting simultaneously against an empty database
 * would race here. Scaling past one instance means moving this back to a release command; see
 * docs/deploy.md.
 *
 * The folder is relative to the working directory — the repo root in dev, `/app` in the image,
 * where the Dockerfile copies `drizzle/` alongside `dist/`.
 */
export async function runMigrations(): Promise<void> {
  logger.info('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  logger.info('Migrations complete.');
}

// Also usable standalone (`npm run migrate`). Guarded so importing runMigrations() from index.ts
// does not trigger the CLI path and its process.exit().
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}
