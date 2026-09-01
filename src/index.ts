/**
 * 对战平台服务器入口
 * 启动流程：初始化日志 -> 加载 SQLite 数据 -> 创建 HTTP 服务 -> 挂载 WebSocket 网关 -> 监听端口
 */
import { config } from './config.js';
import { store } from './db/store.js';
import { createHttpServer } from './http/server.js';
import { Gateway } from './net/gateway.js';
import { logger } from './log/logger.js';

let gateway: Gateway | null = null;

async function main() {
  await logger.init();
  await store.init();

  // 先创建 HTTP 服务器，网关直接挂在 http server 上
  const httpServer = createHttpServer();
  gateway = new Gateway(httpServer);
  gateway.startHeartbeat();
  httpServer.rooms = gateway.rooms;
  httpServer.gateway = gateway;

  httpServer.listen(config.port, config.host, () => {
    logger.info('server', '对战平台服务器已启动', {
      url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
      ws: `ws://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/ws`,
      logFile: logger.currentFile(),
      games: gateway!.rooms.listGameTypes().map((g) => g.name),
    });
  });

  // 优雅退出
  const shutdown = async (signal: string) => {
    logger.info('server', '收到退出信号，正在保存数据并关闭', { signal });
    try {
      gateway?.stop();
    } catch {}
    try {
      await store.close();
    } catch {}
    try {
      await logger.close();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(async (err) => {
  console.error('服务器启动失败:', err);
  try { await logger.close(); } catch {}
  process.exit(1);
});

export { gateway };
