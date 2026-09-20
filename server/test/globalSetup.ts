import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Rebuilds the SQLite test database from the schema before the suite runs.
 * The file is deleted first so each run starts clean; `prisma db push` is then
 * an ordinary create, with no destructive flags.
 */
export default function globalSetup() {
  const serverDir = path.join(__dirname, '..');
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./test.db';

  const file = process.env.DATABASE_URL.replace(/^file:/, '');
  const dbPath = path.isAbsolute(file) ? file : path.join(serverDir, 'prisma', file);
  for (const suffix of ['', '-journal']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }

  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], {
    cwd: serverDir,
    env: { ...process.env },
    stdio: 'ignore',
  });
}
