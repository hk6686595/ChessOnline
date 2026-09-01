/**
 * 匹配系统：相同游戏类型的玩家按积分动态窗口配对，自动建房开局
 *
 * 窗口：起步 ±100，排队每满 5 秒扩大 +100，上限 ±500；超时仍按 config.matchTimeout
 */
import { EVT, ERR, isValidGameType } from '../net/protocol.js';
import { config } from '../config.js';
import { logger } from '../log/logger.js';
import type { Io, PublicUser, QueueEntry, Result } from '../types.js';
import type { RoomManager } from './room.js';

/** 积分匹配窗口参数 */
const RATING_WINDOW_START = 100;
const RATING_WINDOW_STEP = 100;
const RATING_WINDOW_MAX = 500;
const RATING_WINDOW_GROW_MS = 5_000;

export class Matchmaker {
  io: Io;
  roomManager: RoomManager;
  getUser: (userId: string) => PublicUser | null;
  queue: Map<string, QueueEntry>;

  constructor(io: Io, roomManager: RoomManager, getUser: (userId: string) => PublicUser | null) {
    this.io = io;
    this.roomManager = roomManager;
    this.getUser = getUser;
    this.queue = new Map();
  }

  /** 用户是否在队列中 */
  isQueued(userId: string): boolean {
    return this.queue.has(userId);
  }

  /** 当前窗口半宽（分） */
  _windowFor(entry: QueueEntry): number {
    const waited = Date.now() - entry.queuedAt;
    const steps = Math.floor(waited / RATING_WINDOW_GROW_MS);
    return Math.min(RATING_WINDOW_MAX, RATING_WINDOW_START + steps * RATING_WINDOW_STEP);
  }

  /** 入队 */
  enqueue(user: PublicUser, gameType: unknown): Result {
    if (!isValidGameType(gameType)) {
      return { error: ERR.BAD_REQUEST, message: '未知的游戏类型' };
    }
    if (this.queue.has(user.id)) {
      return { error: ERR.ALREADY_MATCHING, message: '你已在匹配队列中' };
    }
    if (this.roomManager.inRoom(user.id)) {
      return { error: ERR.ALREADY_IN_ROOM, message: '请先离开当前房间' };
    }
    const rating = Number.isFinite(user.rating) ? user.rating : 1000;
    const entry: QueueEntry = {
      userId: user.id,
      name: user.name,
      gameType,
      rating,
      queuedAt: Date.now(),
    };
    const timer = setTimeout(() => this._timeout(entry), config.matchTimeout);
    entry.timer = timer;
    this.queue.set(user.id, entry);

    this.io.send(user.id, {
      type: EVT.MATCH_QUEUED,
      gameType,
      position: this._positionOf(gameType, user.id),
      timeoutMs: config.matchTimeout,
      rating,
      message: '正在匹配与您积分相近的对手',
    });
    this._tryPair();
    return { ok: true };
  }

  /** 出队 */
  dequeue(userId: string): Result {
    const entry = this.queue.get(userId);
    if (!entry) return { error: ERR.NOT_MATCHING, message: '你不在匹配队列中' };
    this._remove(entry);
    this.io.send(userId, { type: EVT.MATCH_LEFT });
    return { ok: true };
  }

  /** 移除某个用户（掉线/离开等场景） */
  removeUser(userId: string): void {
    const entry = this.queue.get(userId);
    if (entry) this._remove(entry);
  }

  _remove(entry: QueueEntry): void {
    clearTimeout(entry.timer);
    this.queue.delete(entry.userId);
  }

  _timeout(entry: QueueEntry): void {
    if (!this.queue.has(entry.userId)) return;
    this._remove(entry);
    this.io.send(entry.userId, {
      type: EVT.MATCH_TIMEOUT,
      gameType: entry.gameType,
      message: '匹配超时，请重试',
    });
    logger.info('match', '匹配超时', { userId: entry.userId, name: entry.name, game: entry.gameType });
  }

  _positionOf(gameType: string, excludeUserId: string): number {
    let pos = 0;
    for (const e of this.queue.values()) {
      if (e.gameType === gameType && e.userId !== excludeUserId) pos++;
    }
    return pos + 1;
  }

  /**
   * 尝试配对：同游戏按积分排序，相邻两人分差均在各自当前窗口内则配对。
   * 为照顾久等玩家，也尝试与窗口内任意一人配对（取分差最小）。
   */
  _tryPair() {
    const byGame = new Map<string, QueueEntry[]>();
    for (const entry of this.queue.values()) {
      if (!byGame.has(entry.gameType)) byGame.set(entry.gameType, []);
      byGame.get(entry.gameType)!.push(entry);
    }
    for (const [gameType, entries] of byGame) {
      // 反复配对直到无法再配
      let paired;
      do {
        paired = false;
        // 按入队时间优先尝试（先到的窗口更大、体验更好）
        const sorted = [...entries]
          .filter((e) => this.queue.has(e.userId))
          .sort((a, b) => a.queuedAt - b.queuedAt);
        for (let i = 0; i < sorted.length; i++) {
          const a = sorted[i];
          if (!this.queue.has(a.userId)) continue;
          const winA = this._windowFor(a);
          let best: QueueEntry | null = null;
          let bestDiff = Infinity;
          for (let j = 0; j < sorted.length; j++) {
            if (i === j) continue;
            const b = sorted[j];
            if (!this.queue.has(b.userId)) continue;
            const winB = this._windowFor(b);
            const diff = Math.abs(a.rating - b.rating);
            const allowed = Math.max(winA, winB);
            if (diff <= allowed && diff < bestDiff) {
              best = b;
              bestDiff = diff;
            }
          }
          if (best) {
            // 从 entries 工作副本移除已配的，避免本轮重复
            const ai = entries.indexOf(a);
            const bi = entries.indexOf(best);
            if (ai >= 0) entries.splice(ai, 1);
            const bi2 = entries.indexOf(best);
            if (bi2 >= 0) entries.splice(bi2, 1);
            this._pair(a, best);
            paired = true;
            break;
          }
        }
      } while (paired && entries.filter((e) => this.queue.has(e.userId)).length >= 2);

      // 静默使用 gameType，避免 lint unused
      void gameType;
    }
  }

  /** 配对成功：建房、入房、开局 */
  _pair(a: QueueEntry, b: QueueEntry): void {
    this._remove(a);
    this._remove(b);

    const userA = this.getUser(a.userId);
    const userB = this.getUser(b.userId);
    if (!userA || !userB) {
      // 用户已不存在（如掉线）则回填队列
      if (userA) this.enqueue(userA, a.gameType);
      if (userB) this.enqueue(userB, b.gameType);
      return;
    }

    const created = this.roomManager.createRoom(userA, {
      gameType: a.gameType,
      name: `${a.name} vs ${b.name}`,
      private: true, // 匹配对局不出现在列表
    });
    if (!created.ok || !created.room) return;
    this.io.send(a.userId, { type: EVT.ROOM_JOINED, room: created.room, inviteCode: created.inviteCode });
    const joined = this.roomManager.joinRoom(userB, created.room.id, null);
    if (!joined.ok) {
      this.roomManager.leaveRoom(a.userId);
      return;
    }
    this.io.send(b.userId, { type: EVT.ROOM_JOINED, room: joined.room });
    // 双方自动就绪并开始
    this.roomManager.setReady(a.userId, true);
    this.roomManager.setReady(b.userId, true);
    const started = this.roomManager.startGame(a.userId);
    if (!started.ok) {
      this.roomManager.leaveRoom(a.userId);
      this.roomManager.leaveRoom(b.userId);
      return;
    }

    this.io.send(a.userId, { type: EVT.MATCH_FOUND, room: created.room });
    this.io.send(b.userId, { type: EVT.MATCH_FOUND, room: joined.room });
    logger.info('match', '配对成功', {
      game: a.gameType,
      roomId: created.room!.id,
      players: [a.name, b.name],
      ratings: [a.rating, b.rating],
      ratingDiff: Math.abs(a.rating - b.rating),
      queueSize: this.queue.size,
    });
  }
}
