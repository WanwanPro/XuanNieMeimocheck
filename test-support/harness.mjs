// 轻量 Express 替身：只记录路由并按路径调用，测试不引入任何第三方依赖。
export function createFakeApp() {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ method: 'GET', path, handlers }); },
    post(path, ...handlers) { routes.push({ method: 'POST', path, handlers }); },
    use(...handlers) { routes.push({ method: 'USE', path: '*', handlers }); },
  };
  return { app, routes };
}

export function routeOf(routes, method, path) {
  const found = routes.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`未注册路由：${method} ${path}`);
  return found.handlers;
}

export function createReq({
  method = 'GET', body = {}, query = {}, headers = {}, ip = '127.0.0.1',
} = {}) {
  return { method, body, query, headers, ip, socket: { remoteAddress: ip } };
}

export function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    ended: false,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      this.ended = true;
      return this;
    },
    send(payload) { this.body = payload; this.ended = true; return this; },
    redirect(status, url) { this.statusCode = status; this.location = url; this.ended = true; return this; },
    sendFile() { this.ended = true; },
  };
}

/** 依次执行 handler 链（支持 next 链，最终 handler 直接落 res） */
export async function invoke(handlers, req, res) {
  let index = 0;
  const next = async (err) => {
    if (err) throw err;
    index += 1;
    if (index < handlers.length) await handlers[index](req, res, next);
  };
  await handlers[0](req, res, next);
  return res;
}

export async function waitFor(predicate, { timeout = 2000, interval = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('waitFor 超时');
}
