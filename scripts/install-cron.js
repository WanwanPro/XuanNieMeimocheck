// 把当前 .env 中的 CRON_SCHEDULE 安装为系统 cron 任务。
import { loadConfig } from '../src/envfile.js';
import { installCron } from '../src/cron.js';
import { ENV_FILE } from '../src/paths.js';

const config = loadConfig({ envFile: ENV_FILE });
const file = installCron(config.CRON_SCHEDULE);
console.log(`[cron] 已安装 ${config.CRON_SCHEDULE} -> ${file}`);
