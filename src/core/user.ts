/**
 * 用户系统：注册 / 登录 / 游客 / 会话令牌 / 积分
 *
 * 密码使用 crypto.scrypt 加盐哈希；会话令牌为随机 32 字节 hex。
 * 用户对象：{ id, name, passwordHash?, salt?, isGuest, rating, wins, losses, draws,
 *            createdAt, lastSeen }
 */
import crypto from 'node:crypto';
import { store } from '../db/store.js';
import { config, paths } from '../config.js';
import type {
  Err,
  MatchMove,
  MatchPlayer,
  MatchRecord,
  MatchView,
  PublicUser,
  RankingRow,
  Result,
  UserRecord,
} from '../types.js';

const NAME_RE = /^[\w\u4e00-\u9fa5-]{2,16}$/;

function now() {
  return Date.now();
}

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')): { salt: string; hash: string } {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

export function validateName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  return NAME_RE.test(name);
}

export function validatePassword(pw: unknown): pw is string {
  return typeof pw === 'string' && pw.length >= 4 && pw.length <= 64;
}

/** 创建正式用户 */
export function registerUser(name: unknown, password: unknown): { user?: PublicUser; error?: string; message?: string } {
  if (!validateName(name)) {
    return { error: 'NAME_INVALID', message: '昵称需为 2-16 位中文/字母/数字/下划线/连字符' };
  }
  if (!validatePassword(password)) {
    return { error: 'PASSWORD_INVALID', message: '密码长度需为 4-64 位' };
  }
  const existing = Object.values(store.data.users).find(
    (u) => !u.isGuest && u.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) {
    return { error: 'NAME_TAKEN', message: '该昵称已被注册' };
  }
  const { salt, hash } = hashPassword(password);
  const id = String(store.data.nextUserId++);
  const user = {
    id,
    name,
    passwordHash: hash,
    salt,
    isGuest: false,
    rating: 1000,
    wins: 0,
    losses: 0,
    draws: 0,
    avatar: '🐯',
    createdAt: now(),
    lastSeen: now(),
  };
  store.data.users[id] = user;
  store.touch();
  return { user: publicUser(user) };
}

/** 登录：返回 { user } 或 { error } */
export function loginUser(name: string, password: string): { user?: PublicUser; error?: string; message?: string } {
  const user = Object.values(store.data.users).find(
    (u) => !u.isGuest && u.name.toLowerCase() === name.toLowerCase()
  );
  if (!user || !user.salt || !user.passwordHash || !verifyPassword(password, user.salt, user.passwordHash)) {
    return { error: 'AUTH_FAILED', message: '昵称或密码错误' };
  }
  user.lastSeen = now();
  store.touch();
  return { user: publicUser(user) };
}

/** 游客账号：每次进入随机取名，不入排行榜（仅临时体验） */
export function createGuest(): { user: PublicUser } {
  const id = String(store.data.nextUserId++);
  const name = `游客${1000 + Math.floor(Math.random() * 9000)}`;
  const user: UserRecord = {
    id,
    name,
    isGuest: true,
    rating: 1000,
    wins: 0,
    losses: 0,
    draws: 0,
    avatar: '🐯',
    createdAt: now(),
    lastSeen: now(),
  };
  store.data.users[id] = user;
  store.touch();
  return { user: publicUser(user) };
}

export function getUserById(id: string): PublicUser | null {
  const u = store.data.users[id];
  return u ? publicUser(u) : null;
}

/** 对外暴露的用户信息（不含敏感字段） */
export function publicUser(u: UserRecord): PublicUser {
  return {
    id: u.id,
    name: u.name,
    isGuest: u.isGuest,
    rating: u.rating,
    wins: u.wins,
    losses: u.losses,
    draws: u.draws,
    avatar: u.avatar ?? '🐯',
    createdAt: u.createdAt,
  };
}

/** 生成会话令牌 */
export function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** 对局结束后更新积分（ELO，K=32）与胜负统计 */
export function applyMatchResult(playerIds: string[], winnerId: string | null | undefined, isDraw: boolean | undefined): void {
  const players = playerIds.map((id) => store.data.users[id]).filter(Boolean);
  if (players.length < 2) return;

  if (isDraw) {
    for (const p of players) {
      p.draws += 1;
    }
  } else {
    const winner = winnerId ? store.data.users[winnerId] : undefined;
    const loser = players.find((p) => p.id !== winnerId);
    if (winner && loser) {
      const expW = 1 / (1 + Math.pow(10, (loser.rating - winner.rating) / 400));
      const expL = 1 / (1 + Math.pow(10, (winner.rating - loser.rating) / 400));
      winner.rating = Math.round(winner.rating + 32 * (1 - expW));
      loser.rating = Math.round(loser.rating + 32 * (0 - expL));
      winner.wins += 1;
      loser.losses += 1;
    }
  }
  for (const p of players) p.lastSeen = now();
  store.touch();
}

/** 记录一局历史（含完整棋谱） */
export function recordMatch({ gameType, players, winnerId, isDraw, moves, reason }: {
  gameType: string;
  players: MatchPlayer[];
  winnerId?: string | null;
  isDraw?: boolean;
  moves: MatchMove[];
  reason?: string | null;
}): MatchRecord {
  const rec = {
    id: store.data.nextMatchId++,
    ts: now(),
    gameType,
    players: players.map((p) => ({ id: p.id, name: p.name, rating: p.rating })),
    winnerId: isDraw ? null : (winnerId ?? null),
    isDraw: !!isDraw,
    reason: reason ?? null,
    moveCount: moves.length,
    moves: moves.map((m) => ({
      player: m.player,
      from: m.from,
      to: m.to,
      captured: m.captured ?? null,
      notation: m.notation ?? null,
    })),
    favoritedBy: [], // 收藏该棋谱的用户 id 列表
    deletedBy: [],   // 删除（对自己隐藏）该棋谱的用户 id 列表
  };
  store.data.matches.push(rec);
  store.touch();
  return rec;
}

export function getRecentMatches(limit = 20): MatchRecord[] {
  return store.data.matches.slice(-limit).reverse();
}

/** 查询指定用户的个人历史对局（按时间倒序，不含该用户已删除的） */
export function getUserMatches(userId: string, limit = 50): MatchRecord[] {
  return store.data.matches
    .filter((m) => m.players.some((p) => p.id === userId))
    .filter((m) => !(m.deletedBy ?? []).includes(String(userId)))
    .slice(-limit)
    .reverse();
}

/** 获取单个对局的完整信息（含棋谱） */
export function getMatchById(matchId: number | string): MatchRecord | null {
  const m = store.data.matches.find((x) => x.id === Number(matchId));
  if (!m) return null;
  return m;
}

/** 为客户端整理对局记录视图（含胜负归属与收藏标记） */
export function buildMatchView(m: MatchRecord, viewerId: string): MatchView {
  const me = m.players.find((p) => p.id === viewerId);
  const opp = m.players.find((p) => p.id !== viewerId);
  let result = '平局';
  if (!m.isDraw) result = m.winnerId === viewerId ? '胜' : '负';
  return {
    id: m.id,
    ts: m.ts,
    gameType: m.gameType,
    result,
    moveCount: m.moveCount,
    reason: m.reason,
    opponent: opp ? { id: opp.id, name: opp.name, rating: opp.rating } : null,
    players: m.players,
    favorited: (m.favoritedBy ?? []).includes(String(viewerId)),
  };
}

/**
 * 收藏 / 取消收藏对局棋谱（按用户标记，互不影响）。
 * 返回更新后的对局；对局不存在返回 null。参与者校验由调用方负责。
 */
export function setMatchFavorite(matchId: number | string, userId: string, fav: boolean): MatchRecord | null {
  const m = store.data.matches.find((x) => x.id === Number(matchId));
  if (!m) return null;
  m.favoritedBy ??= [];
  const i = m.favoritedBy.indexOf(String(userId));
  if (fav && i < 0) m.favoritedBy.push(String(userId));
  if (!fav && i >= 0) m.favoritedBy.splice(i, 1);
  store.touch();
  return m;
}

/**
 * 删除对局棋谱（软删除：仅对操作用户隐藏，对手不受影响）。
 * 返回更新后的对局；对局不存在返回 null。参与者校验由调用方负责。
 */
export function deleteMatchForUser(matchId: number | string, userId: string): MatchRecord | null {
  const m = store.data.matches.find((x) => x.id === Number(matchId));
  if (!m) return null;
  m.deletedBy ??= [];
  if (!m.deletedBy.includes(String(userId))) m.deletedBy.push(String(userId));
  store.touch();
  return m;
}

/** 排行榜：按积分排序，游客不参与 */
export function getLeaderboard(limit = config.leaderboardTop): RankingRow[] {
  return Object.values(store.data.users)
    .filter((u) => !u.isGuest)
    .sort((a, b) => b.rating - a.rating || b.wins - a.wins)
    .slice(0, limit)
    .map((u, i) => ({ rank: i + 1, ...publicUser(u) }));
}

/** 可选头像列表（emoji） */
export const AVATARS = ['🐯','🦁','🐻','🐼','🐨','🦊','🐺','🐶','🐱','🐭','🐹','🐰','🐷','🐸','🐵','🐔','🐧','🦆','🦅','🦉','🦇','🦄','🐝','🦋','🐢','🐙','🦑','🦐','🦀','🐠','🐟','🐬','🐳','🦈','🐊','🦓','🦒','🐘','🦏','🦛','🐪','🐫','🦘','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🐈','🐓','🦃','🦚','🦜','🦢','🦩','🕊️','🐇','🦝','🦨','🦡','🦦','🦥','🐁','🐀','🐿️','🦔'];

/** 更新用户头像 */
export function updateAvatar(userId: string, avatar: unknown): Result<{ avatar: string }> {
  const u = store.data.users[userId];
  if (!u) return { error: 'NOT_FOUND', message: '用户不存在' };
  if (typeof avatar !== 'string' || !AVATARS.includes(avatar)) {
    return { error: 'BAD_AVATAR', message: '无效的头像' };
  }
  u.avatar = avatar;
  store.touch();
  return { ok: true, avatar };
}

// ---------------- 管理后台查询 ----------------

/** 管理后台：创建正式用户（昵称/密码校验 + 查重，与注册规则一致） */
export function adminCreateUser(name: unknown, password: unknown): { user?: PublicUser; error?: string; message?: string } {
  if (!validateName(name)) {
    return { error: 'NAME_INVALID', message: '昵称需为 2-16 位中文/字母/数字/下划线/连字符' };
  }
  if (!validatePassword(password)) {
    return { error: 'PASSWORD_INVALID', message: '密码长度需为 4-64 位' };
  }
  const existing = Object.values(store.data.users).find(
    (u) => !u.isGuest && u.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) {
    return { error: 'NAME_TAKEN', message: '该昵称已被注册' };
  }
  const { salt, hash } = hashPassword(password);
  const id = String(store.data.nextUserId++);
  const user: UserRecord = {
    id,
    name,
    passwordHash: hash,
    salt,
    isGuest: false,
    rating: 1000,
    wins: 0,
    losses: 0,
    draws: 0,
    avatar: '🐯',
    createdAt: now(),
    lastSeen: now(),
  };
  store.data.users[id] = user;
  store.touch();
  return { user: publicUser(user) };
}

/** 管理后台：删除用户（正式/游客均可；保留其历史对局记录，账号随即无法登录） */
export function adminDeleteUser(userId: string): Result<{ id: string; name: string; isGuest: boolean }> | Err {
  const result = adminDeleteUsers([userId]);
  if (result.error || !result.deleted) return result;
  const d = result.deleted[0];
  return { ok: true, id: d.id, name: d.name, isGuest: d.isGuest };
}

const MAX_BATCH_DELETE = 200;

/** 管理后台：批量删除用户（去重；部分不存在时仍删除其余账号） */
export function adminDeleteUsers(userIds: unknown[]): Result<{
  deleted: Array<{ id: string; name: string; isGuest: boolean }>;
  notFound: string[];
}> {
  const ids = [...new Set((userIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) return { error: 'BAD_REQUEST', message: '缺少用户 id' };
  if (ids.length > MAX_BATCH_DELETE) {
    return { error: 'BAD_REQUEST', message: `单次最多删除 ${MAX_BATCH_DELETE} 个用户` };
  }
  const deleted: Array<{ id: string; name: string; isGuest: boolean }> = [];
  const notFound: string[] = [];
  const toDelete: string[] = [];
  for (const id of ids) {
    const u = store.data.users[id];
    if (!u) {
      notFound.push(id);
      continue;
    }
    revokeAllTokens(id);
    toDelete.push(id);
    deleted.push({ id: u.id, name: u.name, isGuest: u.isGuest });
  }
  if (toDelete.length) store.deleteUsers(toDelete);
  if (deleted.length === 0) return { error: 'NOT_FOUND', message: '用户不存在' };
  return { ok: true, deleted, notFound };
}

/** 管理后台：用户列表（昵称搜索 + 分页，注册时间倒序） */
export function adminListUsers({ search = '', page = 1, pageSize = 20 }: { search?: string; page?: number; pageSize?: number } = {}) {
  let list = Object.values(store.data.users);
  const kw = String(search || '').trim().toLowerCase();
  if (kw) {
    list = list.filter((u) => u.name.toLowerCase().includes(kw) || u.id === kw);
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  const total = list.length;
  const start = (Number(page) - 1) * Number(pageSize);
  const users = list.slice(start, start + Number(pageSize)).map((u) => ({
    id: u.id,
    name: u.name,
    isGuest: u.isGuest,
    rating: u.rating,
    wins: u.wins,
    losses: u.losses,
    draws: u.draws,
    createdAt: u.createdAt,
    lastSeen: u.lastSeen,
  }));
  return { total, page: Number(page), pageSize: Number(pageSize), users };
}

/** 管理后台：对局列表（分页，最新在前） */
export function adminListMatches({ page = 1, pageSize = 20 }: { page?: number; pageSize?: number } = {}) {
  const list = [...store.data.matches].reverse();
  const total = list.length;
  const start = (Number(page) - 1) * Number(pageSize);
  const matches = list.slice(start, start + Number(pageSize)).map((m) => ({
    id: m.id,
    ts: m.ts,
    gameType: m.gameType,
    players: m.players.map((p) => ({ id: p.id, name: p.name })),
    winnerId: m.winnerId,
    isDraw: m.isDraw,
    reason: m.reason,
    moveCount: m.moveCount,
  }));
  return { total, page: Number(page), pageSize: Number(pageSize), matches };
}

/** 管理后台：统计概览 */
export function adminStats() {
  const users = Object.values(store.data.users);
  return {
    totalUsers: users.length,
    registeredUsers: users.filter((u) => !u.isGuest).length,
    guestUsers: users.filter((u) => u.isGuest).length,
    totalMatches: store.data.matches.length,
    onlineUsers: globalThis.__onlineUsers ?? 0,
    dbFile: paths.dbFile,
  };
}

/** 创建/登录成功后签发会话（同一账号新登录会吊销旧令牌，保证单端在线） */
export function issueSession(userId: string): string {
  const token = createToken();
  const sessions = globalThis.__sessions ??= new Map();
  sessions.set(token, { userId, expiresAt: Date.now() + config.sessionTtl });
  const userTokens = globalThis.__userTokens ??= new Map();
  if (!userTokens.has(userId)) userTokens.set(userId, new Set());
  userTokens.get(userId)!.add(token);
  return token;
}

/** 校验会话令牌，返回 userId 或 null */
export function resolveToken(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  const sessions = globalThis.__sessions ??= new Map();
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    globalThis.__userTokens?.get(s.userId)?.delete(token);
    return null;
  }
  return s.userId;
}

export function revokeToken(token: string): void {
  const sessions = globalThis.__sessions;
  if (!sessions) return;
  const s = sessions.get(token);
  if (s) {
    globalThis.__userTokens?.get(s.userId)?.delete(token);
    sessions.delete(token);
  }
}

/** 吊销某账号全部会话令牌（顶号时调用，使旧设备的令牌立即失效） */
export function revokeAllTokens(userId: string): void {
  const userTokens = globalThis.__userTokens;
  if (!userTokens) return;
  const set = userTokens.get(userId);
  if (!set || set.size === 0) return;
  const sessions = globalThis.__sessions;
  for (const t of set) sessions?.delete(t);
  set.clear();
  userTokens.delete(userId);
}

// ---------------- 好友关系 ----------------

/** 按昵称查找用户（忽略大小写，与注册唯一性一致） */
function findByUsername(name: unknown): UserRecord | null {
  const lower = String(name || '').toLowerCase();
  return Object.values(store.data.users).find((u) => u.name.toLowerCase() === lower) || null;
}

/** 规范化好友对（userA <= userB，数值优先比较，非数字回退字典序） */
function normPair(a: string, b: string): [string, string] {
  const na = Number(a);
  const nb = Number(b);
  const useNum = Number.isFinite(na) && Number.isFinite(nb);
  if (useNum) return na <= nb ? [String(a), String(b)] : [String(b), String(a)];
  return String(a) <= String(b) ? [String(a), String(b)] : [String(b), String(a)];
}

/** 查找两人之间的关系记录（不存在返回 null） */
function findRelation(userId: string, otherId: string) {
  const [a, b] = normPair(userId, otherId);
  return store.data.friends.find((f) => f.userA === a && f.userB === b) || null;
}

/** 返回好友用户公开信息列表（已是好友的） */
export function getFriends(userId: string): PublicUser[] {
  return store.data.friends
    .filter((f) => f.status === 'accepted' && (f.userA === userId || f.userB === userId))
    .map((f) => {
      const otherId = f.userA === userId ? f.userB : f.userA;
      const u = store.data.users[otherId];
      return u ? publicUser(u) : null;
    })
    .filter((u): u is PublicUser => u !== null);
}

/** 待我处理的好友请求（别人向我发起、尚未接受） */
export function getIncomingRequests(userId: string): PublicUser[] {
  return store.data.friends
    .filter((f) => f.status === 'pending' && f.requester !== userId && (f.userA === userId || f.userB === userId))
    .map((f) => {
      const otherId = f.userA === userId ? f.userB : f.userA;
      const u = store.data.users[otherId];
      return u ? publicUser(u) : null;
    })
    .filter((u): u is PublicUser => u !== null);
}

/** 我发出的、待对方处理的好友请求 */
export function getOutgoingRequests(userId: string): PublicUser[] {
  return store.data.friends
    .filter((f) => f.status === 'pending' && f.requester === userId && (f.userA === userId || f.userB === userId))
    .map((f) => {
      const otherId = f.userA === userId ? f.userB : f.userA;
      const u = store.data.users[otherId];
      return u ? publicUser(u) : null;
    })
    .filter((u): u is PublicUser => u !== null);
}

/**
 * 发起好友请求
 * @returns { ok, friend? } 或 { error, message }
 */
export function sendFriendRequest(userId: string, targetName: unknown): Result<{ friend: PublicUser }> {
  const target = findByUsername(targetName);
  if (!target) return { error: 'FRIEND_NOT_FOUND', message: '未找到该用户' };
  if (target.id === userId) return { error: 'FRIEND_SELF', message: '不能添加自己为好友' };
  const rel = findRelation(userId, target.id);
  if (rel) {
    if (rel.status === 'accepted') return { error: 'ALREADY_FRIENDS', message: '你们已经是好友了' };
    return { error: 'FRIEND_REQUEST_EXISTS', message: '好友请求已存在，请等待对方处理' };
  }
  const [a, b] = normPair(userId, target.id);
  store.data.friends.push({
    id: String(store.data.nextFriendId++),
    userA: a,
    userB: b,
    status: 'pending',
    requester: userId,
    createdAt: now(),
  });
  store.touch();
  return { ok: true, friend: publicUser(target) };
}

/** 接受好友请求（仅当对方发起的 pending）；已是好友时幂等返回成功 */
export function acceptFriendRequest(userId: string, friendId: string): Result {
  const rel = findRelation(userId, friendId);
  if (!rel) return { error: 'NOT_FOUND', message: '没有待处理的好友请求' };
  if (rel.status === 'accepted') return { ok: true };
  if (rel.requester === userId) return { error: 'BAD_REQUEST', message: '这是你发出的请求，请等待对方接受' };
  rel.status = 'accepted';
  store.touch();
  return { ok: true };
}

/** 拒绝好友请求 */
export function rejectFriendRequest(userId: string, friendId: string): Result {
  const rel = findRelation(userId, friendId);
  if (!rel || rel.status !== 'pending' || rel.requester === userId) {
    return { error: 'NOT_FOUND', message: '没有待处理的好友请求' };
  }
  const [a, b] = normPair(userId, friendId);
  store.data.friends = store.data.friends.filter((f) => !(f.userA === a && f.userB === b));
  store.touch();
  return { ok: true };
}

/** 删除好友（双向解除） */
export function removeFriend(userId: string, friendId: string): Result {
  const rel = findRelation(userId, friendId);
  if (!rel || rel.status !== 'accepted') return { error: 'NOT_FRIENDS', message: '你们不是好友' };
  const [a, b] = normPair(userId, friendId);
  store.data.friends = store.data.friends.filter((f) => !(f.userA === a && f.userB === b));
  store.touch();
  return { ok: true };
}

/** 是否互为好友（用于定向邀请校验） */
export function isFriend(userId: string, friendId: string): boolean {
  const rel = findRelation(userId, friendId);
  return !!rel && rel.status === 'accepted';
}
