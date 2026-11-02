import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Runs every verify-*.ts suite in its own process and reports a summary. */
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(scriptsDir)
  .filter((name) => name.startsWith('verify-') && name.endsWith('.ts'))
  .sort((left, right) => (left === 'verify-saas.ts' ? -1 : right === 'verify-saas.ts' ? 1 : left.localeCompare(right)));

const failed: string[] = [];
for (const suite of suites) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--import', 'tsx', `${scriptsDir}/${suite}`], {
    encoding: 'utf8',
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const summary = (result.stdout.trim().split('\n').pop() ?? '').slice(0, 140);
  if (result.status === 0) {
    console.log(`PASS  ${suite.padEnd(30)} ${seconds}s  ${summary}`);
  } else {
    failed.push(suite);
    console.log(`FAIL  ${suite.padEnd(30)} ${seconds}s`);
    console.log((result.stdout + result.stderr).split('\n').slice(-25).join('\n'));
  }
}
console.log(`\n${String(suites.length - failed.length)}/${String(suites.length)} suites passed.`);
if (failed.length > 0) process.exitCode = 1;
