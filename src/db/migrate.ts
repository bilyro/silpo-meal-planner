import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './client.js';
import { logger } from '../logger.js';

async function main() {
  logger.info('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  logger.info('Migrations complete.');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});
