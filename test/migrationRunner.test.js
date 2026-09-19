import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runMigrations } from '../src/services/migrationRunner.js';

function createPool({ existingChecksums = {} } = {}) {
  const calls = [];
  const checksums = new Map(Object.entries(existingChecksums));
  const client = {
    query: async (query) => {
      calls.push(query);

      if (typeof query === 'string') {
        return { rows: [] };
      }

      if (query.text.startsWith('select checksum')) {
        const checksum = checksums.get(query.values[0]);
        return { rows: checksum === undefined ? [] : [{ checksum }] };
      }

      if (query.text.startsWith('insert into schema_migrations')) {
        checksums.set(query.values[0], query.values[1]);
      }

      return { rows: [] };
    },
    release: () => calls.push('release'),
  };

  return { calls, checksums, connect: async () => client };
}

async function withMigrations(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'chatmanager-migrations-'));

  try {
    await writeFile(join(directory, '002_reporting.sql'), 'select 2;');
    await writeFile(join(directory, '001_initial.sql'), 'select 1;');
    await writeFile(join(directory, 'ignore.txt'), 'not sql');
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('runMigrations applies ordered SQL files and tracks their checksums', async () => {
  await withMigrations(async (migrationsDirectory) => {
    const pool = createPool();
    const result = await runMigrations({ migrationsDirectory, pool });

    assert.deepEqual(result, [
      { fileName: '001_initial.sql', applied: true },
      { fileName: '002_reporting.sql', applied: true },
    ]);
    assert.equal(pool.checksums.size, 2);
    assert.equal(pool.calls.filter((call) => call === 'begin').length, 2);
    assert.equal(pool.calls.filter((call) => call === 'commit').length, 2);
    assert.equal(pool.calls.at(-1), 'release');
  });
});

test('runMigrations skips an already-applied migration with the same checksum', async () => {
  await withMigrations(async (migrationsDirectory) => {
    const pool = createPool();
    const firstRun = await runMigrations({ migrationsDirectory, pool });
    const executedSql = pool.calls.filter((call) => typeof call === 'string' && call.startsWith('select '));
    const secondRun = await runMigrations({ migrationsDirectory, pool });

    assert.equal(firstRun.filter(({ applied }) => applied).length, 2);
    assert.deepEqual(secondRun, [
      { fileName: '001_initial.sql', applied: false },
      { fileName: '002_reporting.sql', applied: false },
    ]);
    assert.equal(pool.calls.filter((call) => typeof call === 'string' && call.startsWith('select ')).length, executedSql.length);
  });
});

test('runMigrations rejects a changed migration checksum without running its SQL', async () => {
  await withMigrations(async (migrationsDirectory) => {
    const pool = createPool({ existingChecksums: { '001_initial.sql': 'different' } });

    await assert.rejects(
      runMigrations({ migrationsDirectory, pool }),
      /Migration checksum changed: 001_initial\.sql/,
    );
    assert.equal(pool.calls.some((call) => call === 'select 1;'), false);
    assert.equal(pool.calls.at(-2), 'rollback');
    assert.equal(pool.calls.at(-1), 'release');
  });
});

test('runMigrations requires DATABASE_URL when it creates its own pool', async () => {
  await assert.rejects(runMigrations(), /DATABASE_URL is required/);
});
