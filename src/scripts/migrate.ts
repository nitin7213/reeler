import { loadConfig } from '../config.js';
import { createDb, migrate } from '../db.js';

const db = createDb(loadConfig().DATABASE_URL);
try {
  const ran = await migrate(db);
  console.log(ran.length ? `applied: ${ran.join(', ')}` : 'up to date');
} finally {
  await db.end();
}
