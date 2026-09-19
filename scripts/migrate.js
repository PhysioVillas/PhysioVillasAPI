import { getRuntimeConfig } from '../src/config/runtimeConfig.js';
import { runMigrations } from '../src/services/migrationRunner.js';

const config = getRuntimeConfig();

try {
  const result = await runMigrations({ connectionString: config.databaseUrl });
  const applied = result.filter(({ applied: wasApplied }) => wasApplied).length;

  console.log(`Migrations complete: ${applied} applied, ${result.length - applied} already current.`);
} catch (error) {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
}
