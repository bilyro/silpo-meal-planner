import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';

// Exported so shutdown can drain it: an open pool keeps the event loop alive, so without this a
// SIGTERM'd container would sit until the platform's kill timeout expired instead of exiting.
export const pool = new Pool({ connectionString: config.DATABASE_URL });

export const db = drizzle(pool, { schema });
