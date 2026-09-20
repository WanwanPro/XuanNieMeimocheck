// 统一路径常量（可用环境变量覆盖，便于本地调试与测试）。
import { join } from 'path';

export const APP_DIR = process.env.APP_DIR || '/app';
export const LOG_DIR = process.env.LOG_DIR || join(APP_DIR, 'logs');
export const ENV_DIR = process.env.ENV_DIR || join(APP_DIR, '.env-data');
export const USER_DATA_DIR = process.env.USER_DATA_DIR || join(APP_DIR, '.browser-profile');
export const SCRIPT_DIR = process.env.SCRIPT_DIR || join(APP_DIR, 'scripts');
export const PUBLIC_DIR = process.env.PUBLIC_DIR || join(APP_DIR, 'public');

export const LOG_FILE = process.env.LOG_FILE || join(LOG_DIR, 'checkin.log');
export const STATE_FILE = process.env.STATE_FILE || join(LOG_DIR, 'state.json');
export const ENV_FILE = process.env.ENV_FILE || join(ENV_DIR, '.env');
export const LOCK_FILE = process.env.LOCK_FILE || join(LOG_DIR, 'checkin.lock');
export const SCREENSHOT_FILE = process.env.SCREENSHOT_FILE || join(LOG_DIR, 'meimoai-checkin-error.png');
export const CRON_FILE = process.env.CRON_FILE || '/etc/cron.d/meimoai-checkin';
export const CHECKIN_SCRIPT = join(SCRIPT_DIR, 'meimoai-checkin.js');

export const WEB_PORT = Number(process.env.WEB_PORT || 7788);
export const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';
