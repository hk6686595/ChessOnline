/**
 * 服务器配置
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const config: {
  host: string;
  port: number;
  dataDir: string;
  logDir: string;
  logLevel: string;
  logBufferSize: number;
  sessionTtl: number;
  heartbeatInterval: number;
  matchTimeout: number;
  moveTimeLimit: number;
  aiThinkMs: number;
  undoRequestTimeout: number;
  maxRoomMembers: number;
  leaderboardTop: number;
} = {
  // 监听地址与端口
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 8080),

  // 数据目录（SQLite 持久化）
  dataDir: path.join(ROOT, 'data'),

  // 日志目录（按天轮转）
  logDir: path.join(ROOT, 'logs'),

  // 日志级别：DEBUG / INFO / WARN / ERROR（可用环境变量 LOG_LEVEL 覆盖）
  logLevel: process.env.LOG_LEVEL || 'INFO',

  // 内存中保留的最近日志条数（供 /api/logs 查询）
  logBufferSize: 1000,

  // 会话令牌有效期（毫秒），默认 7 天
  sessionTtl: 7 * 24 * 3600 * 1000,

  // WebSocket 心跳间隔（毫秒）
  heartbeatInterval: 30_000,

  // 匹配队列超时后仍可等待的最大时长（毫秒），超时提示
  matchTimeout: 120_000,

  // 每步走子时限（秒），超时未走子判负（可用环境变量 MOVE_TIME_LIMIT 覆盖）
  moveTimeLimit: Number(process.env.MOVE_TIME_LIMIT || 60),

  // 电脑（AI）每步思考时间（毫秒），接入 eleeye 引擎
  aiThinkMs: Number(process.env.AI_THINK_MS || 1500),

  // 悔棋请求等待对方回应的超时（毫秒）
  undoRequestTimeout: 30_000,

  // 单房间最大人数（含观战）
  maxRoomMembers: 8,

  // 排行榜取前 N 名
  leaderboardTop: 50,
};

export const paths = {
  root: ROOT,
  // SQLite 数据库文件
  dbFile: path.join(config.dataDir, 'platform.db'),
};
