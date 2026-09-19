import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const migrationFilePattern = /^\d+_[\w-]+\.sql$/;

function requireConnectionString(connectionString) {
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new TypeError('DATABASE_URL is required.');
  }

  return connectionString.trim();
}

async function readMigrations(migrationsDirectory) {
  const fileNames = (await readdir(migrationsDirectory))
    .filter((fileName) => migrationFilePattern.test(fileName))
    .sort();

  return Promise.all(fileNames.map(async (fileName) => {
    const sql = await readFile(join(migrationsDirectory, fileName), 'utf8');

    return {
      fileName,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  }));
}

async function ensureMigrationTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      file_name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function applyMigration(client, migration) {
  await client.query('begin');

  try {
    await ensureMigrationTable(client);
    const existing = await client.query({
      text: 'select checksum from schema_migrations where file_name = $1',
      values: [migration.fileName],
    });

    if (existing.rows.length > 0) {
      if (existing.rows[0].checksum !== migration.checksum) {
        throw new Error(`Migration checksum changed: ${migration.fileName}`);
      }

      await client.query('commit');
      return { fileName: migration.fileName, applied: false };
    }

    await client.query(migration.sql);
    await client.query({
      text: 'insert into schema_migrations (file_name, checksum) values ($1, $2)',
      values: [migration.fileName, migration.checksum],
    });
    await client.query('commit');

    return { fileName: migration.fileName, applied: true };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function runMigrations({
  connectionString,
  migrationsDirectory = new URL('../../db/migrations/', import.meta.url),
  pool,
} = {}) {
  const resolvedPool = pool ?? new Pool({
    connectionString: requireConnectionString(connectionString),
  });
  const client = await resolvedPool.connect();

  try {
    const migrations = await readMigrations(migrationsDirectory);
    const result = [];

    for (const migration of migrations) {
      result.push(await applyMigration(client, migration));
    }

    return result;
  } finally {
    client.release();

    if (pool === undefined) {
      await resolvedPool.end();
    }
  }
}

export { readMigrations, runMigrations };
