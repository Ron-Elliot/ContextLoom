import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://contextloom:contextloom@localhost:5432/contextloom';

async function migrate(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows: applied } = await pool.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    const appliedVersions = new Set(applied.map((r) => r.version));

    const migrationsDir = join(__dirname, '..', 'migrations');
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    let ran = 0;
    for (const file of files) {
      if (appliedVersions.has(file)) {
        console.log(`  skip  ${file}`);
        continue;
      }

      const sql = await readFile(join(migrationsDir, file), 'utf8');
      console.log(`  run   ${file}`);

      await pool.query('BEGIN');
      try {
        await pool.query(sql);
        await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await pool.query('COMMIT');
        ran++;
      } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
      }
    }

    console.log(`\nMigrations complete. ${ran} new migration(s) applied.`);
  } finally {
    await pool.end();
  }
}

migrate().catch((err: Error) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
