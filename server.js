// 兼容旧 Dockerfile / entrypoint 的启动入口。
import { startWebServer } from './src/web/server.js';

startWebServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
