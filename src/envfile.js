// .env 文件的解析 / 序列化 / 原子写入。
//
// 为什么不用 dotenv：dotenv 对双引号值的反转义不完整（"a\"b" 会保留反斜杠），
// 密码里出现引号 / 反斜杠 / # 时会静默写错。这里用 JSON 字符串承载值，
// 可以无损地往返任意字符，同时兼容历史版本的裸值格式。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { CONFIG_KEYS, CONFIG_SCHEMA } from './config.js';

/** 解析单个值：优先按 JSON 字符串解析，失败则回退到裸值 / 旧引号格式 */
export function parseEnvValue(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** 读取 .env 文件为对象；文件不存在返回空对象 */
export function parseEnvFile(path) {
  const out = {};
  if (!path || !existsSync(path)) return out;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = parseEnvValue(line.slice(idx + 1));
  }
  return out;
}

/** 序列化为 .env 文本，值一律用 JSON 字符串包裹 */
export function serializeEnv(values, order) {
  const keys = order && order.length ? order : Object.keys(values);
  const seen = new Set();
  const lines = [];
  for (const key of keys) {
    if (seen.has(key) || values[key] === undefined) continue;
    seen.add(key);
    lines.push(`${key}=${JSON.stringify(String(values[key]))}`);
  }
  return lines.join('\n') + '\n';
}

/** 原子写入：先写临时文件再 rename，避免进程中断产生半截配置 */
export function writeEnvAtomic(path, values, order) {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, serializeEnv(values, order), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * 装载完整配置：默认值 <- process.env（已知键）<- .env 文件。
 * .env 文件是持久化的事实来源，优先级最高（与 entrypoint 的"已存在则保留"语义一致）。
 */
export function loadConfig({ envFile, processEnv = process.env } = {}) {
  const values = {};
  for (const key of CONFIG_KEYS) values[key] = CONFIG_SCHEMA[key].default;

  if (processEnv) {
    for (const key of CONFIG_KEYS) {
      const v = processEnv[key];
      if (v !== undefined && v !== '') values[key] = v;
    }
  }

  if (envFile && existsSync(envFile)) {
    const fileValues = parseEnvFile(envFile);
    for (const key of CONFIG_KEYS) {
      if (fileValues[key] !== undefined) values[key] = fileValues[key];
    }
  }

  return values;
}
