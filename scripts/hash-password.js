// 生成 WEB_PASSWORD 的 scrypt 哈希，填入 .env 或 Web 设置页
// 用法：npm run hash
import { randomBytes, scryptSync } from 'crypto';
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

const password = await ask('请输入要加密的管理密码：');
rl.close();

if (!password) {
  console.error('密码不能为空');
  process.exit(1);
}

const salt = randomBytes(16).toString('hex');
const hash = scryptSync(Buffer.from(password), Buffer.from(salt, 'hex'), 64).toString('hex');

console.log('\n请将以下完整字符串填入 WEB_PASSWORD（scrypt$salt$hash 格式）：');
console.log(`scrypt$${salt}$${hash}`);
