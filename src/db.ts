import { Pool } from 'pg';

const pool = new Pool({
  connectionString:
    process.env['CONTEXTLOOM_DATABASE_URL'] ??
    'postgresql://contextloom:contextloom@localhost:5432/contextloom',
});

export default pool;
