// 纯拆分工具：tools/_page.html -> public/{index.html,styles.css,app.js}
// _page.html 是唯一前端源文件，所有功能都在其中直接实现，不再做任何字符串注入。
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(root, 'tools', '_page.html');
const publicDir = join(root, 'public');
const source = readFileSync(sourcePath, 'utf8');
const styleMatches = [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)];
const scriptMatches = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];

if (styleMatches.length !== 1) {
  throw new Error(`tools/_page.html 应恰好包含 1 个 <style> 块，实际 ${styleMatches.length} 个`);
}
if (scriptMatches.length !== 1) {
  throw new Error(`tools/_page.html 应恰好包含 1 个 <script> 块，实际 ${scriptMatches.length} 个`);
}

const style = styleMatches[0][1].trim();
const script = scriptMatches[0][1].trim();
if (!style || !script) {
  throw new Error('tools/_page.html 的 <style> 或 <script> 块不能为空');
}

const html = source
  .replace(/<style>[\s\S]*?<\/style>/, '<link rel="stylesheet" href="/styles.css">')
  .replace(/<script>[\s\S]*?<\/script>/, '<script src="/app.js" defer></script>')
  .trimStart();

mkdirSync(publicDir, { recursive: true });
writeFileSync(join(publicDir, 'index.html'), html, 'utf8');
writeFileSync(join(publicDir, 'styles.css'), `${style}\n`, 'utf8');
writeFileSync(join(publicDir, 'app.js'), `'use strict';\n${script}\n`, 'utf8');
console.log('generated public/index.html, public/styles.css, public/app.js');
