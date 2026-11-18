import pg from 'pg';

const connectionString = process.env.DATABASE_URL?.trim();
const days = process.argv[2] === undefined ? 60 : Number(process.argv[2]);

if (!connectionString) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

if (!Number.isInteger(days) || days < 0 || days > 730) {
  console.error('Usage: npm run extend-schedule [days 0-730]');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });

try {
  const result = await pool.query('select clinica_simulada.extend_schedule($1::int) as inserted', [days]);
  console.log(`Schedule extended: ${result.rows[0].inserted} rows inserted.`);
} catch (error) {
  console.error(`Schedule extension failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
