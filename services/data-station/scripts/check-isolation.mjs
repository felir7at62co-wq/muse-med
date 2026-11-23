import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const baseline = JSON.parse(readFileSync(resolve('artifacts/isolation-before.json'), 'utf8'));
const failures = [];
const processes = [];
for (const original of baseline.protected_processes.filter(Boolean)) {
  const pid = original.trim().split(/\s+/)[0];
  let current;
  try {
    current = execFileSync('ps', ['-p', pid, '-o', 'pid=,lstart=,command='], { encoding: 'utf8' }).trim();
  } catch {
    failures.push(`Protected process ${pid} is no longer present.`);
    continue;
  }
  if (current !== original) failures.push(`Protected process ${pid} changed.`);
  processes.push({ pid, unchanged: current === original });
}
const main = '/Users/Admin/.codex/worktrees/muse-main-coordinator-integration-20261112';
const head = execFileSync('git', ['-C', main, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const status = execFileSync('git', ['-C', main, 'status', '--porcelain'], { encoding: 'utf8' });
if (head !== baseline.muse_main_head) failures.push('Muse main HEAD changed since baseline.');
if (status !== baseline.muse_main_status) failures.push('Muse main working directory changed since baseline.');
const result = { checkedAt: new Date().toISOString(), processes, mainHeadUnchanged: head === baseline.muse_main_head, mainStatusUnchanged: status === baseline.muse_main_status, failures };
writeFileSync(resolve('artifacts/isolation-after.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exitCode = 1;
