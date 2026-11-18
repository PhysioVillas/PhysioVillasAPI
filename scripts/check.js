import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['src', 'scripts'].map((dir) => join(root, dir));

function collectJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path);
    }
  }
  return files;
}

const files = roots.flatMap(collectJsFiles).sort();
const failures = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures.push({ file, output: String(error.stderr ?? error.message) });
  }
}

for (const failure of failures) {
  console.error(`Syntax check failed: ${relative(root, failure.file)}\n${failure.output}`);
}

if (failures.length > 0) {
  console.error(`check: ${failures.length} of ${files.length} file(s) failed`);
  process.exit(1);
}

console.log(`check: ${files.length} file(s) OK`);
