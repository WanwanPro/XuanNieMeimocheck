// 配置的唯一事实来源（single source of truth）。
// 签到脚本、Web 服务、容器初始化脚本都从这里读取 schema / 默认值 / 校验规则，
// 避免多处硬编码配置项导致的漂移。

export const CONFIG_SCHEMA = {
  MEIMOAI_ACCOUNT: {
    default: '', secret: true, required: true, type: 'text', label: '登录账号',
  },
  MEIMOAI_PASSWORD: {
    default: '', secret: true, required: true, type: 'text', label: '登录密码',
  },
  MEIMOAI_URL: {
    default: 'https://meimoai13.com/', secret: false, type: 'url', label: '站点地址',
  },
  CRON_SCHEDULE: {
    default: '0 1 * * *', secret: false, required: true, type: 'cron', label: '定时规则',
  },
  RANDOM_DELAY: {
    default: 'true', secret: false, type: 'bool', label: '随机延迟',
  },
  RANDOM_DELAY_MAX_MINUTES: {
    default: '300', secret: false, type: 'int', min: 0, max: 1440, label: '随机延迟上限(分钟)',
  },
  SKIP_PROBABILITY: {
    default: '0.05', secret: false, type: 'float', min: 0, max: 1, label: '跳过概率(0~1)',
  },
  MAX_CONSECUTIVE_FAILURES: {
    default: '3', secret: false, type: 'int', min: 1, max: 30, label: '连续失败熔断阈值',
  },
  PROXY_SERVER: {
    default: '', secret: true, type: 'text', label: '代理服务器(可选)',
  },
  WANWAN_PUSH_TOKEN: {
    default: '', secret: true, type: 'text', label: 'Wanwan Token',
  },
  PUSHPLUS_TOKEN: {
    default: '', secret: true, type: 'text', label: 'PushPlus Token',
  },
  SERVERCHAN_SENDKEY: {
    default: '', secret: true, type: 'text', label: 'ServerChan SendKey',
  },
  WEBHOOK_URL: {
    default: '', secret: true, type: 'text', label: 'Webhook URL',
  },
  WEB_PASSWORD: {
    default: '', secret: true, type: 'text', label: '管理密码',
  },
  WEB_TRUST_PROXY: {
    default: '', secret: false, type: 'text', label: '反向代理信任（重启生效）',
  },
  FEISHU_SSO_ENABLED: {
    default: 'false', secret: false, type: 'bool', label: '飞书 SSO 开关',
  },
  FEISHU_APP_ID: {
    default: '', secret: false, type: 'text', label: '飞书 App ID',
  },
  FEISHU_APP_SECRET: {
    default: '', secret: true, type: 'text', label: '飞书 App Secret',
  },
  FEISHU_REDIRECT_URI: {
    default: '', secret: false, type: 'url', label: '飞书回调地址',
  },
  FEISHU_ALLOWED_TENANT_KEYS: {
    default: '', secret: false, type: 'text', label: '允许的企业 tenant_key',
  },
  FEISHU_ALLOWED_OPEN_IDS: {
    default: '', secret: false, type: 'text', label: '允许的用户 open_id',
  },
  FEISHU_SCOPE: {
    default: '', secret: false, type: 'text', label: '飞书授权 scope(可选)',
  },
};

export const CONFIG_KEYS = Object.freeze(Object.keys(CONFIG_SCHEMA));

/** 用于表示"保持原值不变"的掩码占位符 */
export const MASK = '********';

export function isSecretKey(key) {
  return Boolean(CONFIG_SCHEMA[key] && CONFIG_SCHEMA[key].secret);
}

/** 飞书 OAuth 回调地址必须 HTTPS（本机调试可 HTTP），并固定到回调路径。 */
export function isValidFeishuRedirectUri(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  let url;
  try { url = new URL(v); } catch { return false; }
  if (url.username || url.password || url.hash) return false;
  const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) return false;
  return url.pathname === '/api/auth/feishu/callback';
}

/**
 * Express trust proxy 配置：支持 false / 跳数 / loopback / IP / CIDR。
 *
 * 刻意不接受 true / all：那会信任任意客户端伪造的 X-Forwarded-For，
 * 使登录限流与审计 IP 失效。传入危险值时降级为 false（不信任代理）。
 */
export function parseTrustProxy(value) {
  const v = String(value || '').trim();
  if (!v || /^(false|off|no|0)$/i.test(v)) return false;
  if (/^(true|all)$/i.test(v)) return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/** 是否为危险的 trust proxy 取值（true/all），用于启动告警。 */
export function isDangerousTrustProxy(value) {
  return /^(true|all)$/i.test(String(value || '').trim());
}

/** 5 段 cron 表达式校验（分 时 日 月 周，支持 *、列表、范围和步长） */
const CRON_BOUNDS = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7],  // day of week（7 = Sunday）
];

function isValidCronField(field, min, max) {
  return field.split(",").every((part) => {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match) return false;
    const [, startRaw, endRaw, stepRaw] = match;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return false;
    if (startRaw === "*") return endRaw === undefined;
    const start = Number(startRaw);
    const end = endRaw === undefined ? start : Number(endRaw);
    return Number.isInteger(start) && Number.isInteger(end)
      && start >= min && end <= max && start <= end;
  });
}

export function isValidCron(expr) {
  if (!expr || typeof expr !== "string") return false;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => isValidCronField(field, CRON_BOUNDS[index][0], CRON_BOUNDS[index][1]));
}


/** 校验单个配置项，返回错误信息；通过则返回 null */
export function validateValue(key, value, options = {}) {
  const spec = CONFIG_SCHEMA[key];
  if (!spec) return `未知配置项：${key}`;
  if (typeof value !== 'string') return `${key} 必须是字符串`;
  if (/[\r\n\u0000]/.test(value)) return `${key} 的值包含非法字符`;

  const v = value.trim();
  if (spec.required && !v && !options.allowEmpty) return `${key} 不能为空`;

  switch (spec.type) {
    case 'cron':
      if (!v || !isValidCron(v)) return `${key} 不是合法的 5 段 cron 表达式（如 0 1 * * *）`;
      break;
    case 'bool':
      if (v && !/^(true|false)$/i.test(v)) return `${key} 只能是 true 或 false`;
      break;
    case 'int': {
      if (!v) break;
      if (!/^-?\d+$/.test(v)) return `${key} 必须是整数`;
      const n = Number(v);
      if (spec.min !== undefined && n < spec.min) return `${key} 不能小于 ${spec.min}`;
      if (spec.max !== undefined && n > spec.max) return `${key} 不能大于 ${spec.max}`;
      break;
    }
    case 'float': {
      if (!v) break;
      if (!/^-?\d+(\.\d+)?$/.test(v)) return `${key} 必须是数字`;
      const n = Number(v);
      if (spec.min !== undefined && n < spec.min) return `${key} 不能小于 ${spec.min}`;
      if (spec.max !== undefined && n > spec.max) return `${key} 不能大于 ${spec.max}`;
      break;
    }
    case 'url':
      if (v && !/^https?:\/\/\S+$/i.test(v)) return `${key} 必须是 http(s):// 开头的地址`;
      if (v && key === 'FEISHU_REDIRECT_URI' && !isValidFeishuRedirectUri(v)) {
        return `${key} 必须使用 HTTPS（本机调试可用 localhost HTTP），且路径为 /api/auth/feishu/callback`;
      }
      break;
    default:
      break;
  }
  return null;
}

/** 批量校验，返回错误数组（空数组 = 全部通过） */
export function validateConfig(values) {
  const errors = [];
  for (const [k, v] of Object.entries(values)) {
    const err = validateValue(k, v);
    if (err) errors.push(err);
  }
  return errors;
}

export function boolValue(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null || v === '') return fallback;
  return String(v).trim().toLowerCase() === 'true';
}

export function intValue(v, fallback = 0) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function floatValue(v, fallback = 0) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
