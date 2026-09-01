/**
 * 数据持久化：SQLite（Node 内置 node:sqlite，零外部依赖）
 *
 * 内存缓存 + 同步落盘：业务代码通过 store.data 读写（与原 JSON 版兼容），
 * 每次修改后调用 touch() 立即同步写入 SQLite（ACID，无需原子写/防抖）。
 *
 * 表：
 *   users   用户（含游客）
 *   matches 历史对局（仅保留最近 500 条）
 *   friends 好友关系（pending=待接受 / accepted=已是好友）
 */
import { DatabaseSync } from 'node:sqlite';
import fsp from 'node:fs/promises';
import { config, paths } from '../config.js';
import { logger } from '../log/logger.js';
import type { FriendRelation, FriendStatus, MatchRecord, OfflineMessage, StoreData, UserRecord } from '../types.js';

const MAX_MATCHES = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  password_hash TEXT,
  salt          TEXT,
  is_guest      INTEGER NOT NULL DEFAULT 0,
  rating        INTEGER NOT NULL DEFAULT 1000,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  draws         INTEGER NOT NULL DEFAULT 0,
  avatar        TEXT NOT NULL DEFAULT '🐯',
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  game_type    TEXT NOT NULL,
  players      TEXT NOT NULL,
  winner_id    TEXT,
  is_draw      INTEGER NOT NULL DEFAULT 0,
  reason       TEXT,
  move_count   INTEGER NOT NULL DEFAULT 0,
  moves        TEXT,
  favorited_by TEXT NOT NULL DEFAULT '[]',
  deleted_by   TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS friends (
  id         INTEGER PRIMARY KEY,
  user_a     TEXT NOT NULL,
  user_b     TEXT NOT NULL,
  status     TEXT NOT NULL,
  requester  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_pair ON friends(user_a, user_b);
CREATE TABLE IF NOT EXISTS offline_messages (
  id        INTEGER PRIMARY KEY,
  from_id   TEXT NOT NULL,
  from_name TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  text      TEXT NOT NULL,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offline_to ON offline_messages(to_id);
`;

interface UserRow {
  id: number;
  name: string;
  password_hash: string | null;
  salt: string | null;
  is_guest: number;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  avatar: string | null;
  created_at: number;
  last_seen: number;
}

interface MatchRow {
  id: number;
  ts: number;
  game_type: string;
  players: string;
  winner_id: string | null;
  is_draw: number;
  reason: string | null;
  move_count: number;
  moves: string | null;
  favorited_by: string | null;
  deleted_by: string | null;
}

interface FriendRow {
  id: number;
  user_a: string;
  user_b: string;
  status: string;
  requester: string;
  created_at: number;
}

interface OfflineRow {
  id: number;
  from_id: string;
  from_name: string;
  to_id: string;
  text: string;
  ts: number;
}

interface ColumnInfo {
  name: string;
}

class SqliteStore {
  db: DatabaseSync | null;
  _checkpointTimer: ReturnType<typeof setInterval> | null;
  data: StoreData;

  constructor() {
    this.db = null;
    this._checkpointTimer = null;
    this.data = {
      users: {},
      matches: [],
      friends: [],
      offlineMessages: [],
      nextUserId: 1,
      nextMatchId: 1,
      nextFriendId: 1,
      nextOfflineMsgId: 1,
    };
  }

  /** 打开数据库、建表、加载数据 */
  async init() {
    await fsp.mkdir(config.dataDir, { recursive: true });
    this.db = new DatabaseSync(paths.dbFile);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // 清理好友表中的重复配对（保留最小 id），再建唯一索引
    try {
      const hasFriends = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='friends'").get();
      if (hasFriends) {
        this.db.exec('DELETE FROM friends WHERE id NOT IN (SELECT MIN(id) FROM friends GROUP BY user_a, user_b)');
      }
    } catch (err) {
      logger.warn('store', '清理好友重复记录失败', { error: (err as Error).message });
    }
    this.db.exec(SCHEMA);
    // 迁移：为已有 users 表添加 avatar 列（若不存在）
    try {
      const cols = this.db.prepare("PRAGMA table_info(users)").all() as unknown as ColumnInfo[];
      if (!cols.some((c) => c.name === 'avatar')) {
        this.db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '🐯'");
        logger.info('store', '已为 users 表添加 avatar 列');
      }
    } catch (err) {
      logger.warn('store', 'avatar 列迁移失败', { error: (err as Error).message });
    }
    // 迁移：为已有 matches 表补充缺失的列（moves / favorited_by / deleted_by）
    try {
      const cols = this.db.prepare("PRAGMA table_info(matches)").all() as unknown as ColumnInfo[];
      const addCol = (name: string, ddl: string) => {
        if (cols.some((c) => c.name === name)) return;
        this.db!.exec(`ALTER TABLE matches ADD COLUMN ${ddl}`);
        logger.info('store', `已为 matches 表添加 ${name} 列`);
      };
      addCol('moves', 'moves TEXT');
      addCol('favorited_by', "favorited_by TEXT NOT NULL DEFAULT '[]'");
      addCol('deleted_by', "deleted_by TEXT NOT NULL DEFAULT '[]'");
    } catch (err) {
      logger.warn('store', 'matches 表列迁移失败', { error: (err as Error).message });
    }
    this._load();
    // 周期自动 checkpoint：把 WAL 定期合并进主文件，
    // 避免主文件 platform.db 长时间不更新（便于直接查看/备份，即使强杀也不丢数据）
    this._checkpointTimer = setInterval(() => {
      try {
        this.db?.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      } catch { /* 忽略：下次再试 */ }
    }, 10_000);
    this._checkpointTimer.unref?.();
    logger.info('store', 'SQLite 数据加载完成', {
      file: paths.dbFile,
      users: Object.keys(this.data.users).length,
      matches: this.data.matches.length,
    });
  }

  _load() {
    // 用户
    const rows = this.db!.prepare('SELECT * FROM users').all() as unknown as UserRow[];
    const users: Record<string, UserRecord> = {};
    for (const r of rows) {
      users[String(r.id)] = {
        id: String(r.id),
        name: r.name,
        passwordHash: r.password_hash ?? undefined,
        salt: r.salt ?? undefined,
        isGuest: !!r.is_guest,
        rating: r.rating,
        wins: r.wins,
        losses: r.losses,
        draws: r.draws,
        avatar: r.avatar ?? '🐯',
        createdAt: r.created_at,
        lastSeen: r.last_seen,
      };
    }
    this.data.users = users;
    this.data.nextUserId = rows.length ? Math.max(...rows.map((r) => r.id)) + 1 : 1;

    // 对局（最近 500 条，按时间正序）
    const mrows = (this.db!
      .prepare('SELECT * FROM matches ORDER BY id DESC LIMIT ?')
      .all(MAX_MATCHES) as unknown as MatchRow[])
      .reverse();
    this.data.matches = mrows.map((r) => ({
      id: r.id,
      ts: r.ts,
      gameType: r.game_type,
      players: JSON.parse(r.players),
      winnerId: r.winner_id ?? null,
      isDraw: !!r.is_draw,
      reason: r.reason ?? null,
      moveCount: r.move_count,
      moves: r.moves ? JSON.parse(r.moves) : null,
      favoritedBy: JSON.parse(r.favorited_by ?? '[]'),
      deletedBy: JSON.parse(r.deleted_by ?? '[]'),
    }));
    this.data.nextMatchId = mrows.length ? Math.max(...mrows.map((r) => r.id)) + 1 : 1;

    // 好友关系
    const frows = this.db!.prepare('SELECT * FROM friends ORDER BY id').all() as unknown as FriendRow[];
    this.data.friends = frows.map((r) => ({
      id: r.id,
      userA: String(r.user_a),
      userB: String(r.user_b),
      status: r.status as FriendStatus,
      requester: String(r.requester),
      createdAt: r.created_at,
    }));
    this.data.nextFriendId = frows.length ? Math.max(...frows.map((r) => r.id)) + 1 : 1;

    // 离线私聊消息
    const orows = this.db!.prepare('SELECT * FROM offline_messages ORDER BY id').all() as unknown as OfflineRow[];
    this.data.offlineMessages = orows.map((r) => ({
      id: r.id,
      fromId: String(r.from_id),
      fromName: r.from_name,
      toId: String(r.to_id),
      text: r.text,
      ts: r.ts,
    }));
    this.data.nextOfflineMsgId = orows.length ? Math.max(...orows.map((r) => r.id)) + 1 : 1;
  }

  /** 保存一条离线私聊消息（内存 + 落盘） */
  addOfflineMessage(msg: Omit<OfflineMessage, 'id'>): OfflineMessage {
    const rec = { id: this.data.nextOfflineMsgId++, ...msg };
    this.data.offlineMessages.push(rec);
    if (this.db) {
      try {
        this.db.prepare(
          'INSERT INTO offline_messages (id, from_id, from_name, to_id, text, ts) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(rec.id, rec.fromId, rec.fromName, rec.toId, rec.text, rec.ts);
      } catch (err) {
        logger.error('store', '离线消息写入失败', { error: (err as Error).message });
      }
    }
    return rec;
  }

  /** 取出并删除某用户的全部离线消息（投递后调用） */
  drainOfflineMessages(toId: string): OfflineMessage[] {
    const list = this.data.offlineMessages.filter((m) => m.toId === String(toId));
    if (list.length === 0) return [];
    this.data.offlineMessages = this.data.offlineMessages.filter((m) => m.toId !== String(toId));
    if (this.db) {
      try {
        this.db.prepare('DELETE FROM offline_messages WHERE to_id = ?').run(String(toId));
      } catch (err) {
        logger.error('store', '离线消息删除失败', { error: (err as Error).message });
      }
    }
    return list;
  }

  /** 删除用户（内存 + SQLite 同步删除，避免重启后复活） */
  deleteUser(id: string): void {
    this.deleteUsers([id]);
  }

  /** 批量删除用户（一条 SQL，同一事务语义） */
  deleteUsers(ids: string[]): void {
    const unique = [...new Set((ids || []).map((id) => String(id)).filter(Boolean))];
    if (unique.length === 0) return;
    for (const id of unique) delete this.data.users[id];
    if (!this.db) return;
    try {
      const nums = unique.map((id) => Number(id)).filter((n) => Number.isFinite(n));
      if (nums.length === 0) return;
      const placeholders = nums.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...nums);
    } catch (err) {
      logger.error('store', 'SQLite 删除用户失败', { error: (err as Error).message, count: unique.length });
      throw err;
    }
  }

  /** 将内存状态同步写入 SQLite（业务代码在修改后调用） */
  touch() {
    if (!this.db) return;
    this.db.exec('BEGIN');
    try {
      const upsertUser = this.db.prepare(`
        INSERT INTO users (id, name, password_hash, salt, is_guest, rating, wins, losses, draws, avatar, created_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          password_hash = excluded.password_hash,
          salt = excluded.salt,
          is_guest = excluded.is_guest,
          rating = excluded.rating,
          wins = excluded.wins,
          losses = excluded.losses,
          draws = excluded.draws,
          avatar = excluded.avatar,
          created_at = excluded.created_at,
          last_seen = excluded.last_seen
      `);
      for (const u of Object.values(this.data.users)) {
        upsertUser.run(
          Number(u.id), u.name, u.passwordHash ?? null, u.salt ?? null,
          u.isGuest ? 1 : 0, u.rating, u.wins, u.losses, u.draws,
          u.avatar ?? '🐯', u.createdAt, u.lastSeen
        );
      }

      const upsertMatch = this.db.prepare(`
        INSERT INTO matches (id, ts, game_type, players, winner_id, is_draw, reason, move_count, moves, favorited_by, deleted_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          ts = excluded.ts,
          game_type = excluded.game_type,
          players = excluded.players,
          winner_id = excluded.winner_id,
          is_draw = excluded.is_draw,
          reason = excluded.reason,
          move_count = excluded.move_count,
          moves = excluded.moves,
          favorited_by = excluded.favorited_by,
          deleted_by = excluded.deleted_by
      `);
      const recent = this.data.matches.slice(-MAX_MATCHES);
      for (const m of recent) {
        upsertMatch.run(
          m.id, m.ts, m.gameType, JSON.stringify(m.players),
          m.winnerId ?? null, m.isDraw ? 1 : 0, m.reason ?? null, m.moveCount,
          m.moves ? JSON.stringify(m.moves) : null,
          JSON.stringify(m.favoritedBy ?? []), JSON.stringify(m.deletedBy ?? [])
        );
      }
      // 清理超出保留上限的历史对局
      this.db.exec(`DELETE FROM matches WHERE id NOT IN (SELECT id FROM matches ORDER BY id DESC LIMIT ${MAX_MATCHES})`);

      const upsertFriend = this.db.prepare(`
        INSERT INTO friends (id, user_a, user_b, status, requester, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_a, user_b) DO UPDATE SET
          status = excluded.status,
          requester = excluded.requester
      `);
      for (const f of this.data.friends) {
        upsertFriend.run(Number(f.id), f.userA, f.userB, f.status, f.requester, f.createdAt);
      }

      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* 忽略 */ }
      logger.error('store', 'SQLite 写入失败', { error: (err as Error).message });
      throw err;
    }
  }

  /** 立即落盘（保持 API 兼容） */
  async flushNow() {
    this.touch();
  }

  /** 关闭数据库（先落盘 + 完整合并 WAL 到主文件） */
  async close() {
    this.touch();
    try {
      this.db?.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch { /* 忽略 */ }
    if (this._checkpointTimer) {
      clearInterval(this._checkpointTimer);
      this._checkpointTimer = null;
    }
    try { this.db?.close(); } catch { /* 忽略 */ }
    this.db = null;
  }
}

export const store = new SqliteStore();

export { DatabaseSync };
