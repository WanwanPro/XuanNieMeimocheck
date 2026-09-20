// 容器首次启动：把 compose/environment 中的配置写入持久化 .env。
import { existsSync } from 'fs';
import { CONFIG_KEYS } from '../src/config.js';
import { loadConfig, writeEnvAtomic } from '../src/envfile.js';
import { ENV_FILE } from '../src/paths.js';

if (existsSync(ENV_FILE)) {
  console.log(`[init-env] 已存在，保留现有配置：${ENV_FILE}`);
} else {
  const config = loadConfig();
  writeEnvAtomic(ENV_FILE, config, CONFIG_KEYS);
  console.log(`[init-env] 已生成：${ENV_FILE}`);
}
