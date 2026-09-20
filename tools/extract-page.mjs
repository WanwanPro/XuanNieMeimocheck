import { readFileSync, writeFileSync } from "fs";

// 仅用于历史上 server.js 内联 HTML_PAGE 模板时的迁移；现已不再适用。
// server.js 早已改为从 public/ 提供静态文件，这里保留脚本仅为历史记录。
const raw = readFileSync("server.js", "utf8");
const key = "const HTML_PAGE = `";
const start = raw.indexOf(key);
if (start === -1) {
  console.error("server.js 已不再内联 HTML_PAGE 模板，extract-page.mjs 已废弃。");
  console.error("前端唯一源文件是 tools/_page.html，修改后用 `node tools/split-web.mjs` 重新生成 public/。");
  process.exit(1);
}
const end = raw.indexOf("`;", start + key.length);
if (end === -1) {
  console.error("未找到 HTML_PAGE 模板结束标记，拒绝写入以避免破坏 tools/_page.html。");
  process.exit(1);
}
const lit = raw.slice(start + key.length, end);
const html = new Function("return `" + lit + "`;")();

writeFileSync("tools/_page.html", html, "utf8");
console.log("html length:", html.length);
console.log("body offset:", html.indexOf("</style>"));
console.log("--- inline handlers ---");
for (const m of html.matchAll(/on(?:click|change|submit|input|load)="[^"]*"/g)) {
  console.log(m.index, "|", m[0].slice(0, 120));
}
