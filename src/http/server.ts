/**
 * HTTP 服务器：REST API（WPF 客户端主要走 WebSocket，REST 作为辅助接口）
 * 另提供 /admin 数据管理页（浏览器直接查看 SQLite 用户与对局数据）
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import * as userApi from '../core/user.js';
import { listGameTypes } from '../games/index.js';
import { store } from '../db/store.js';
import { logger } from '../log/logger.js';
import type { Gateway } from '../net/gateway.js';
import type { RoomManager } from '../core/room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let adminHtml: string | null = null;

export interface AppHttpServer extends http.Server {
  rooms: RoomManager | null;
  gateway?: Gateway;
}

export function createHttpServer(): AppHttpServer {
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.debug('http', '请求完成', {
        method: req.method,
        path: req.url,
        status: res.statusCode,
        ms: Date.now() - startedAt,
      });
    });
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url, server as AppHttpServer);
      }
      if (url.pathname === '/healthz') {
        return json(res, 200, { ok: true, ts: Date.now(), rooms: (server as AppHttpServer).rooms?.roomCount ?? 0 });
      }
      if (url.pathname === '/admin') {
        return serveAdminPage(res);
      }
      return json(res, 404, { error: 'NOT_FOUND', message: `未知路径: ${url.pathname}` });
    } catch (err) {
      logger.error('http', '处理请求异常', { path: req.url, error: (err as Error).message });
      json(res, 500, { error: 'internal_error', message: '服务器内部错误' });
    }
  }) as AppHttpServer;
  server.rooms = null;
  return server;
}

interface HttpError extends Error {
  status?: number;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 64 * 1024) {
      const err = new Error('请求体过大') as HttpError;
      err.status = 413;
      throw err;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const err = new Error('请求体不是合法 JSON') as HttpError;
    err.status = 400;
    throw err;
  }
}

/** 从 query (?id= / ?ids=1,2) 与 JSON body 收集待删除用户 id（去重） */
function collectUserIds(url: URL, body: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const qId = String(url.searchParams.get('id') || '').trim();
  const qIds = String(url.searchParams.get('ids') || '').trim();
  if (qId) ids.push(qId);
  if (qIds) ids.push(...qIds.split(/[,]+/).map((s) => s.trim()).filter(Boolean));
  const raw = body?.ids ?? body?.id;
  if (Array.isArray(raw)) ids.push(...raw.map((x) => String(x).trim()).filter(Boolean));
  else if (raw != null && String(raw).trim()) ids.push(String(raw).trim());
  return [...new Set(ids)];
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, server: AppHttpServer): Promise<void> {
  const p = url.pathname.replace(/^\/api/, '') || '/';
  const rooms = server?.rooms ?? null;

  // ---- 认证 ----
  if (p === '/auth/register' && req.method === 'POST') {
    const body = await readBody(req);
    const { user, error } = userApi.registerUser(body.name, body.password);
    if (error || !user) return json(res, 400, { error, message: '注册失败' });
    const token = userApi.issueSession(user.id);
    return json(res, 200, { ok: true, token, user });
  }
  if (p === '/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body.token === 'string' && body.token) {
      const uid = userApi.resolveToken(body.token);
      const user = uid ? userApi.getUserById(uid) : null;
      if (!user) return json(res, 401, { error: 'AUTH_FAILED', message: '令牌无效或已过期' });
      // 单端登录：新登录吊销旧令牌
      userApi.revokeAllTokens(uid!);
      const token = userApi.issueSession(uid!);
      return json(res, 200, { ok: true, token, user });
    }
    const { user, error } = userApi.loginUser(String(body.name || ''), String(body.password || ''));
    if (error || !user) return json(res, 401, { error, message: '昵称或密码错误' });
    userApi.revokeAllTokens(user.id);
    const token = userApi.issueSession(user.id);
    return json(res, 200, { ok: true, token, user });
  }
  if (p === '/auth/guest' && req.method === 'POST') {
    const { user } = userApi.createGuest();
    const token = userApi.issueSession(user.id);
    return json(res, 200, { ok: true, token, user });
  }

  // ---- 数据查询 ----
  if (p === '/admin/stats' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...userApi.adminStats() });
  }
  if (p === '/admin/users' && req.method === 'GET') {
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') || 20)));
    return json(res, 200, { ok: true, ...userApi.adminListUsers({ search: url.searchParams.get('search') || '', page, pageSize }) });
  }
  if (p === '/admin/users' && req.method === 'POST') {
    // 管理后台：创建用户
    const body = await readBody(req);
    const { user, error, message } = userApi.adminCreateUser(body.name, body.password);
    if (error || !user) return json(res, 400, { error, message });
    logger.info('admin', '管理员创建用户', { userId: user.id, name: user.name });
    return json(res, 200, { ok: true, user });
  }
  if (p === '/admin/users' && req.method === 'DELETE') {
    // 管理后台：删除用户（?id= / ?ids=1,2,3 / JSON { ids: [...] }）
    const body = await readBody(req);
    const ids = collectUserIds(url, body);
    if (ids.length === 0) return json(res, 400, { error: 'BAD_REQUEST', message: '缺少用户 id' });
    const result = userApi.adminDeleteUsers(ids);
    if (result.error || !result.deleted) return json(res, 400, { error: result.error, message: result.message });
    for (const d of result.deleted) {
      server?.gateway?.kickUserAll(d.id, '账号已被管理员删除，请重新注册');
    }
    logger.info('admin', '管理员删除用户', {
      count: result.deleted.length,
      users: result.deleted.map((d) => ({ userId: d.id, name: d.name, isGuest: d.isGuest })),
      notFound: result.notFound,
    });
    return json(res, 200, { ok: true, deleted: result.deleted, notFound: result.notFound });
  }
  if (p === '/admin/matches' && req.method === 'GET') {
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') || 20)));
    return json(res, 200, { ok: true, ...userApi.adminListMatches({ page, pageSize }) });
  }
  if (p === '/logs' && req.method === 'GET') {
    const lines = Number(url.searchParams.get('lines') || 200);
    return json(res, 200, {
      ok: true,
      file: logger.currentFile(),
      logs: logger.recent(Math.min(Math.max(lines, 1), 1000)),
    });
  }
  if (p === '/health' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      ts: Date.now(),
      rooms: rooms?.roomCount ?? 0,
      totalUsers: Object.keys(store.data.users).length,
      totalMatches: store.data.matches.length,
    });
  }
  if (p === '/rooms' && req.method === 'GET') {
    return json(res, 200, { ok: true, rooms: rooms?.listRooms?.() ?? [] });
  }
  if (p === '/leaderboard' && req.method === 'GET') {
    return json(res, 200, { ok: true, rankings: userApi.getLeaderboard(config.leaderboardTop) });
  }
  if (p === '/games' && req.method === 'GET') {
    return json(res, 200, { ok: true, games: listGameTypes() });
  }
  if (p === '/matches' && req.method === 'GET') {
    const userId = url.searchParams.get('user');
    if (userId) {
      // 个人历史战绩
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      const matches = userApi
        .getUserMatches(userId, limit)
        .map((m) => userApi.buildMatchView(m, userId));
      return json(res, 200, { ok: true, matches });
    }
    return json(res, 200, { ok: true, matches: userApi.getRecentMatches(20) });
  }
  if (p === '/users/me' && req.method === 'GET') {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const uid = userApi.resolveToken(token);
    const user = uid ? userApi.getUserById(uid) : null;
    if (!user) return json(res, 401, { error: 'AUTH_FAILED', message: '未登录或令牌失效' });
    return json(res, 200, { ok: true, user });
  }
  if (p === '/stats' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      rooms: rooms?.roomCount ?? 0,
      totalUsers: Object.keys(store.data.users).length,
      totalMatches: store.data.matches.length,
    });
  }

  return json(res, 404, { error: 'NOT_FOUND', message: `未知接口: ${p}` });
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 返回数据管理页（内存缓存） */
async function serveAdminPage(res: ServerResponse): Promise<void> {
  try {
    if (adminHtml === null) {
      adminHtml = await fsp.readFile(path.join(__dirname, 'admin.html'), 'utf8');
    }
    const body = Buffer.from(adminHtml, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    logger.error('http', '管理页加载失败', { error: (err as Error).message });
    json(res, 500, { error: 'internal_error', message: '管理页加载失败' });
  }
}
