// 兼容旧入口：cron / Web 都通过这个薄封装启动签到主流程。
import { runCheckin } from '../src/checkin/index.js';

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0) return process.argv[idx + 1] || '';
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : '';
}

const manual = process.argv.includes('--manual');
const dryRun = process.argv.includes('--dry-run');
const runId = argValue('--run-id');
const code = await runCheckin({ manual, dryRun, runId });
process.exitCode = code;
