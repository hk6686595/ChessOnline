/**
 * 日志系统：控制台 + 文件（按天轮转）+ 内存环形缓冲（供 /api/logs 查询）
 *
 * 用法：
 *   import { logger } from '../log/logger.js';
 *   logger.info('auth', '注册成功', { userId: '1', name: '张三' });
 *   logger.debug('room', '落子', { roomId, move });
 *
 * 级别：DEBUG < INFO < WARN < ERROR，默认 INFO（环境变量 LOG_LEVEL 可覆盖）。
 * 文件：logs/app-YYYY-MM-DD.log，UTF-8 追加写。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVELS: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地时间戳：2026-08-19 13:04:51.123 */
function ts() {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
  );
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

class Logger {
  level: number;
  buffer: string[];
  stream: fs.WriteStream | null;
  currentDate: string;

  constructor() {
    this.level = LEVELS[config.logLevel as LogLevel] ?? LEVELS.INFO;
    this.buffer = [];
    this.stream = null;
    this.currentDate = '';
  }

  /** 初始化：创建日志目录 */
  async init() {
    await fsp.mkdir(config.logDir, { recursive: true });
    this._openStream();
    this.info('log', '日志系统已启动', {
      dir: config.logDir,
      level: config.logLevel,
      maxBuffer: config.logBufferSize,
    });
  }

  _openStream() {
    const date = today();
    if (this.stream && date === this.currentDate) return;
    try { this.stream?.end(); } catch { /* 忽略 */ }
    this.stream = fs.createWriteStream(path.join(config.logDir, `app-${date}.log`), {
      flags: 'a',
      encoding: 'utf8',
    });
    this.stream.on('error', (err: Error) => console.error('[log] 日志文件写入错误:', err.message));
    this.currentDate = date;
  }

  _write(level: LogLevel, module: string, msg: string, extra?: unknown): void {
    if (LEVELS[level] < this.level) return;
    const line = `[${ts()}] [${level}] [${module}] ${msg}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}`;

    // 控制台
    console.log(line);

    // 内存缓冲（供 /api/logs）
    this.buffer.push(line);
    if (this.buffer.length > config.logBufferSize) this.buffer.shift();

    // 文件（按天轮转）
    try {
      this._openStream();
      this.stream?.write(line + '\n');
    } catch (err) {
      console.error('[log] 写入失败:', (err as Error).message);
    }
  }

  debug(module: string, msg: string, extra?: unknown) { this._write('DEBUG', module, msg, extra); }
  info(module: string, msg: string, extra?: unknown) { this._write('INFO', module, msg, extra); }
  warn(module: string, msg: string, extra?: unknown) { this._write('WARN', module, msg, extra); }
  error(module: string, msg: string, extra?: unknown) { this._write('ERROR', module, msg, extra); }

  /** 最近 N 条日志（供 REST 查询） */
  recent(n = 200): string[] {
    return this.buffer.slice(-n);
  }

  /** 当前日志文件路径 */
  currentFile() {
    return path.join(config.logDir, `app-${today()}.log`);
  }

  /** 关闭文件流 */
  async close() {
    this.info('log', '日志系统关闭');
    await new Promise<void>((resolve) => {
      try { this.stream?.end(() => resolve()); } catch { resolve(); }
    });
    this.stream = null;
  }
}

export const logger = new Logger();
