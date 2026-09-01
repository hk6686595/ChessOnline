/**
 * 房间系统：创建 / 加入 / 离开 / 就绪 / 开始 / 观战 / 踢人 / 重开 / 快进
 *
 * 房间状态：
 *   status: 'waiting' | 'playing'
 *   players: 对局玩家（含 owner），spectators: 观战者（仅支持观战的游戏）
 *
 * 与外部解耦：通过 io 接口发送消息
 *   io.send(userId, msg)  /  io.sendToMany(userIds, msg)  /  io.broadcastAll(msg)
 */
import crypto from 'node:crypto';
import { ERR, EVT, GAME_TYPES, isValidGameType } from '../net/protocol.js';
import { getGame, listGameTypes } from '../games/index.js';
import { genLegalMoves } from '../games/xiangqi.js';
import { bestMove as xiangqiBestMove } from '../games/xiangqi-ai.js';
import { bestMove as gomokuBestMove } from '../games/gomoku-ai.js';
import { ucciEngine } from '../games/uci-engine.js';
import { config } from '../config.js';
import * as userApi from './user.js';
import { logger } from '../log/logger.js';
import type {
  FirstMove,
  GameState,
  GameTypeInfo,
  Io,
  PlayerRef,
  PublicRoom,
  PublicUser,
  Result,
  Room,
  RoomConfig,
  RoomSeat,
  RoomView,
} from '../types.js';

const ID_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const OFFLINE_GRACE_MS = 60_000;
/** 人机对局中电脑玩家的虚拟用户 ID */
const AI_USER_ID = '__ai__';
/** 电脑思考延迟范围（毫秒），模拟"思考"节奏 */
const AI_THINK_MIN = 500;
const AI_THINK_MAX = 1200;
/** 每步时限可设置范围（秒）与先手方合法值 */
export const TIME_LIMIT_MIN = 5;
export const TIME_LIMIT_MAX = 600;
/** 局时（包干）可设置范围（秒）；0 = 关闭，仅用步时 */
export const GAME_TIME_MIN = 60;
export const GAME_TIME_MAX = 3600;
/** 求和被拒后需再过的半回合数（双方各约 2 步）才能再提 */
export const DRAW_COOLDOWN_PLIES = 4;
/** 悔棋/求和请求等待超时（毫秒）——与 config.undoRequestTimeout 一致，求和复用 */
const FIRST_MOVE_VALUES = ['owner', 'opponent']; // owner=房主先手，opponent=对方先手

/**
 * 人机难度档位
 *  - engine: 'builtin' 用内置 minimax（depth 越小越弱，randomTopK 越大越随机）
 *            'eleeye'  用象眼引擎（thinkMs 越大越强）
 */
export const AI_LEVELS: Record<string, {
  label: string;
  engine: 'builtin' | 'eleeye';
  depth?: number;
  randomTopK?: number;
  thinkMs?: number;
  desc: string;
}> = {
  rookie: { label: '新手', engine: 'builtin', depth: 1, randomTopK: 5, desc: '走子随意，适合初学者' },
  easy:   { label: '入门', engine: 'builtin', depth: 2, randomTopK: 3, desc: '会吃子，偶有失误' },
  medium: { label: '进阶', engine: 'builtin', depth: 3, randomTopK: 1, desc: '标准水平（默认）' },
  hard:   { label: '高手', engine: 'eleeye',  thinkMs: 600,           desc: '象眼引擎·快速思考' },
  master: { label: '大师', engine: 'eleeye',  thinkMs: 2000,          desc: '象眼引擎·全力计算' },
};
export const AI_LEVEL_IDS = Object.keys(AI_LEVELS);
export const DEFAULT_AI_LEVEL = 'medium';

/** 校验并归一化难度 id（非人机房间返回 null） */
function normalizeAiLevel(vsAI: boolean, level: unknown): string | null {
  if (!vsAI) return null;
  const id = typeof level === 'string' ? level : '';
  return AI_LEVELS[id] ? id : DEFAULT_AI_LEVEL;
}

function genRoomId() {
  let id = '';
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) id += ID_CHARSET[b % ID_CHARSET.length];
  return id;
}

function genInviteCode() {
  return genRoomId().slice(0, 4);
}

export class RoomManager {
  io: Io;
  rooms: Map<string, Room>;
  userRoom: Map<string, string>;
  _offlineTimers: Map<string, ReturnType<typeof setTimeout>>;

  constructor(io: Io) {
    this.io = io;
    this.rooms = new Map();
    this.userRoom = new Map();
    this._offlineTimers = new Map();
  }

  listGameTypes(): GameTypeInfo[] {
    return listGameTypes();
  }

  /** 对外可见房间列表（不含 private 房间） */
  listRooms(): PublicRoom[] {
    const rooms: PublicRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.private) continue;
      rooms.push(this._publicRoom(room));
    }
    return rooms.sort((a, b) => a.createdAt - b.createdAt);
  }

  _publicRoom(room: Room): PublicRoom {
    const game = getGame(room.gameType);
    return {
      id: room.id,
      name: room.name,
      gameType: room.gameType,
      gameName: game ? game.name : room.gameType,
      hasPassword: !!room.password,
      status: room.status,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      spectatorCount: room.spectators.length,
      ownerName: room.owner ? room.owner.name : '',
      createdAt: room.createdAt,
    };
  }

  /** 发给指定用户的完整房间视图 */
  /** 对外可见的对局设置（未自定义时限时回退服务器默认值） */
  _publicConfig(room: Room): { timeLimit: number; gameTime: number; firstMove: FirstMove } {
    return {
      timeLimit: room.config?.timeLimit ?? config.moveTimeLimit,
      gameTime: room.config?.gameTime ?? 0,
      firstMove: room.config?.firstMove ?? 'owner',
    };
  }

  /** 按先手设置排列对局席位（game.players[0] 恒为先手方：象棋红方 / 五子棋黑方） */
  _gameSeats(room: Room): PlayerRef[] {
    const seats = room.players.map((p) => ({ id: p.id, name: p.name }));
    return room.config?.firstMove === 'opponent' ? seats.reverse() : seats;
  }

  _roomViewFor(room: Room, _userId?: string): RoomView {
    const game = getGame(room.gameType);
    const view: RoomView = {
      id: room.id,
      name: room.name,
      gameType: room.gameType,
      gameName: game ? game.name : room.gameType,
      hasPassword: !!room.password,
      status: room.status,
      ownerId: room.ownerId,
      maxPlayers: room.maxPlayers,
      mode: room.mode || 'pvp',
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        isOwner: p.id === room.ownerId,
        ready: p.ready,
        online: p.online,
      })),
      spectators: room.spectators.map((s) => ({ id: s.id, name: s.name, online: s.online })),
      config: this._publicConfig(room),
      createdAt: room.createdAt,
    };
    if (room.status === 'playing' && room.game) {
      view.game = game!.serialize(room.game);
    }
    return view;
  }

  _broadcastRoom(room: Room): void {
    const memberIds = new Set([
      ...room.players.map((p) => p.id),
      ...room.spectators.map((s) => s.id),
    ]);
    const view = this._roomViewFor(room);
    this.io.sendToMany([...memberIds], { type: EVT.ROOM_UPDATE, room: view });
  }

  // ---------- 生命周期 ----------

  /** 创建房间（vsAI=true 时为单人模式，自动加入电脑玩家） */
  createRoom(user: PublicUser, opts: {
    gameType?: string;
    name?: string;
    password?: string | null;
    private?: boolean;
    vsAI?: boolean;
    aiLevel?: unknown;
  } = {}): Result<{ room: RoomView; inviteCode: string }> {
    const gameType = opts.gameType || GAME_TYPES.XIANGQI;
    if (!isValidGameType(gameType)) {
      return { error: ERR.BAD_REQUEST, message: '未知的游戏类型' };
    }
    if (this.userRoom.has(user.id)) {
      return { error: ERR.ALREADY_IN_ROOM, message: '你已在其他房间中' };
    }
    const game = getGame(gameType);
    if (!game) return { error: ERR.BAD_REQUEST, message: '未知的游戏类型' };
    const id = genRoomId();
    const vsAI = !!opts.vsAI;
    const aiLevel = normalizeAiLevel(vsAI, opts.aiLevel);
    const room: Room = {
      id,
      inviteCode: genInviteCode(),
      name: (opts.name || (vsAI ? `${game.name}（人机）` : `${game.name}房间 #${id.slice(0, 4)}`)).slice(0, 24),
      gameType,
      maxPlayers: game.maxPlayers,
      password: opts.password || null,
      private: !!opts.private || vsAI, // 人机房间不出现在列表
      mode: vsAI ? 'ai' : 'pvp',
      aiId: vsAI ? AI_USER_ID : null,
      aiLevel,
      ownerId: user.id,
      status: 'waiting',
      config: { timeLimit: null, gameTime: 0, firstMove: 'owner' }, // 对局设置（房主可改，开局生效）
      players: [this._seat(user)],
      spectators: [],
      game: null,
      createdAt: Date.now(),
    };
    if (vsAI) {
      // 电脑玩家自动就绪，永远在线
      room.players.push({ id: AI_USER_ID, name: '电脑', ready: true, online: true });
    }
    this.rooms.set(id, room);
    this.userRoom.set(user.id, id);
    this._cancelOfflineTimer(user.id);
    logger.info('room', vsAI ? '创建人机房间' : '创建房间', { userId: user.id, roomId: id, game: gameType });
    return { ok: true, room: this._roomViewFor(room, user.id), inviteCode: room.inviteCode };
  }

  _seat(user: PlayerRef): RoomSeat {
    return { id: user.id, name: user.name, ready: false, online: true };
  }

  /** 加入房间（含观战） */
  joinRoom(user: PublicUser, roomId: string, password: string | null | undefined): Result<{ room: RoomView; spectator: boolean }> {
    const room = this.rooms.get(String(roomId || '').toUpperCase());
    if (!room) return { error: ERR.NOT_FOUND, message: '房间不存在' };
    if (room.mode === 'ai') {
      return { error: ERR.BAD_REQUEST, message: '这是人机对战房间，请创建自己的对局' };
    }
    if (this.userRoom.has(user.id)) {
      return { error: ERR.ALREADY_IN_ROOM, message: '你已在其他房间中' };
    }
    if (room.password && room.password !== password) {
      return { error: ERR.WRONG_PASSWORD, message: '房间密码错误' };
    }

    const game = getGame(room.gameType);
    if (!game) return { error: ERR.BAD_REQUEST, message: '未知的游戏类型' };
    // 对局进行中：仅支持观战的游戏可加入观战
    if (room.status === 'playing') {
      if (!game.supportsSpectate) {
        return { error: ERR.ROOM_FULL, message: '对局已开始，无法加入' };
      }
      if (room.spectators.length + room.players.length >= config.maxRoomMembers) {
        return { error: ERR.ROOM_FULL, message: '房间人数已满' };
      }
      room.spectators.push(this._seat(user));
      this.userRoom.set(user.id, room.id);
      this._cancelOfflineTimer(user.id);
      return { ok: true, room: this._roomViewFor(room, user.id), spectator: true };
    }

    // 等待中：作为玩家加入
    if (room.players.length >= room.maxPlayers) {
      return { error: ERR.ROOM_FULL, message: '房间已满' };
    }
    room.players.push(this._seat(user));
    this.userRoom.set(user.id, room.id);
    this._cancelOfflineTimer(user.id);
    this._broadcastRoom(room); // 通知房主与其他成员
    return { ok: true, room: this._roomViewFor(room, user.id), spectator: false };
  }

  /** 快进：随机加入一个等待中的房间 */
  quickJoin(user: PublicUser, gameType?: string): Result<{ room: RoomView; spectator: boolean }> {
    const candidates = [...this.rooms.values()].filter(
      (r) =>
        r.status === 'waiting' &&
        !r.password &&
        r.players.length < r.maxPlayers &&
        (!gameType || r.gameType === gameType)
    );
    if (candidates.length === 0) return { error: ERR.NOT_FOUND, message: '暂无可加入的房间' };
    const room = candidates[Math.floor(Math.random() * candidates.length)];
    return this.joinRoom(user, room.id, null);
  }

  /** 离开房间 */
  leaveRoom(userId: string): { ok: boolean; roomId?: string } {
    const roomId = this.userRoom.get(userId);
    if (!roomId) return { ok: false };
    const room = this.rooms.get(roomId);
    if (!room) {
      this.userRoom.delete(userId);
      return { ok: true };
    }
    this._removeFromRoom(room, userId);
    return { ok: true, roomId };
  }

  /** 从房间中移除某用户（内部） */
  _removeFromRoom(room: Room, userId: string): void {
    const pIdx = room.players.findIndex((p) => p.id === userId);
    const sIdx = room.spectators.findIndex((s) => s.id === userId);
    if (pIdx === -1 && sIdx === -1) return;

    const member = pIdx !== -1 ? room.players[pIdx] : room.spectators[sIdx];
    if (pIdx !== -1) {
      room.players.splice(pIdx, 1);
      // 对局进行中玩家离开 => 对手直接获胜
      if (room.status === 'playing' && room.game && !room.game.over) {
        this._forfeit(room, userId, `${member.name} 离开房间`);
      }
      // 转移房主
      if (room.ownerId === userId && room.players.length > 0) {
        room.ownerId = room.players[0].id;
      }
    } else {
      room.spectators.splice(sIdx, 1);
    }
    this.userRoom.delete(userId);
    this._broadcastRoom(room);
    this._maybeRemoveRoom(room);
  }

  /** 无玩家时销毁房间 */
  _maybeRemoveRoom(room: Room): boolean {
    if (room.players.length === 0 && room.spectators.length === 0) {
      this.rooms.delete(room.id);
      logger.info('room', '房间已销毁（无成员）', { roomId: room.id, name: room.name });
      return true;
    }
    return false;
  }

  /** 用户离线处理：游客立即离开，正式用户宽限 60s 等待重连，超时后移除 */
  onUserOffline(userId: string, isGuest: boolean): void {
    const roomId = this.userRoom.get(userId);
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    if (!room) {
      this.userRoom.delete(userId);
      return;
    }
    const member = [...room.players, ...room.spectators].find((m) => m.id === userId);
    if (!member) {
      this.userRoom.delete(userId);
      return;
    }
    member.online = false;

    if (isGuest) {
      // 游客掉线：直接离房（对局中自动判负）
      logger.info('room', '游客掉线离开房间', { userId, roomId: room.id, name: member.name });
      this._removeFromRoom(room, userId);
      return;
    }
    this._broadcastRoom(room);
    logger.info('room', '用户掉线，等待重连（60 秒宽限）', { userId, roomId: room.id, name: member.name });
    // 宽限期内等待重连，超时后移除（对局中会自动判负）
    const timer = setTimeout(() => {
      this._offlineTimers.delete(userId);
      const cur = this.rooms.get(roomId);
      if (!cur) return;
      const still = [...cur.players, ...cur.spectators].find((m) => m.id === userId);
      if (!still || still.online) return;
      this._removeFromRoom(cur, userId);
    }, OFFLINE_GRACE_MS);
    this._offlineTimers.set(userId, timer);
  }

  /** 用户重连恢复 */
  onUserReconnect(userId: string): RoomView | null {
    const roomId = this.userRoom.get(userId);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const member = [...room.players, ...room.spectators].find((m) => m.id === userId);
    if (!member) return null;
    member.online = true;
    this._cancelOfflineTimer(userId);
    this._broadcastRoom(room);
    return this._roomViewFor(room, userId);
  }

  _cancelOfflineTimer(userId: string): void {
    const t = this._offlineTimers.get(userId);
    if (t) {
      clearTimeout(t);
      this._offlineTimers.delete(userId);
    }
  }

  // ---------- 房间操作 ----------

  /**
   * 房主修改对局设置（每步时限 / 局时 / 先后手），仅等待中可改，改动广播全房间
   * opts: { timeLimit?: 秒, gameTime?: 秒(0=关闭), firstMove?: 'owner' | 'opponent' }
   */
  setConfig(userId: string, opts: { timeLimit?: number | null; gameTime?: number | null; firstMove?: string | null } = {}): Result<{ config: RoomConfig; roomId: string }> {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (room.ownerId !== userId) return { error: ERR.NOT_OWNER, message: '只有房主可以修改对局设置' };
    if (room.status !== 'waiting') {
      return { error: ERR.GAME_ALREADY_STARTED, message: '对局已开始，无法修改设置' };
    }
    if (opts.timeLimit !== undefined && opts.timeLimit !== null) {
      const tl = Number(opts.timeLimit);
      if (!Number.isInteger(tl) || tl < TIME_LIMIT_MIN || tl > TIME_LIMIT_MAX) {
        return { error: ERR.BAD_REQUEST, message: `每步时限需为 ${TIME_LIMIT_MIN}-${TIME_LIMIT_MAX} 秒的整数` };
      }
      room.config.timeLimit = tl;
    }
    if (opts.gameTime !== undefined && opts.gameTime !== null) {
      const gt = Number(opts.gameTime);
      if (!Number.isInteger(gt) || (gt !== 0 && (gt < GAME_TIME_MIN || gt > GAME_TIME_MAX))) {
        return {
          error: ERR.BAD_REQUEST,
          message: `局时需为 0（关闭）或 ${GAME_TIME_MIN}-${GAME_TIME_MAX} 秒的整数`,
        };
      }
      room.config.gameTime = gt;
    }
    if (opts.firstMove !== undefined && opts.firstMove !== null) {
      if (!FIRST_MOVE_VALUES.includes(opts.firstMove as FirstMove)) {
        return { error: ERR.BAD_REQUEST, message: '先后手设置不合法' };
      }
      room.config.firstMove = opts.firstMove as FirstMove;
    }
    this._broadcastRoom(room);
    logger.info('room', '更新对局设置', { roomId: room.id, by: userId, config: this._publicConfig(room) });
    return { ok: true, config: this._publicConfig(room), roomId: room.id };
  }

  /** 就绪/取消就绪 */
  setReady(userId: string, ready: boolean): Result {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    const seat = room.players.find((p) => p.id === userId);
    if (!seat) return { error: ERR.NOT_IN_ROOM, message: '观战者无需就绪' };
    if (room.status !== 'waiting') return { error: ERR.GAME_ALREADY_STARTED, message: '对局已开始' };
    seat.ready = !!ready;
    this._broadcastRoom(room);
    return { ok: true };
  }

  /** 房主开始对局 */
  startGame(userId: string): Result<{ roomId: string }> {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (room.ownerId !== userId) return { error: ERR.NOT_OWNER, message: '只有房主可以开始' };
    if (room.status !== 'waiting') return { error: ERR.GAME_ALREADY_STARTED, message: '对局已开始' };
    const game = getGame(room.gameType);
    if (!game) return { error: ERR.BAD_REQUEST, message: '未知的游戏类型' };
    if (room.players.length < game.minPlayers) {
      return { error: ERR.BAD_REQUEST, message: `至少需要 ${game.minPlayers} 名玩家` };
    }
    if (!room.players.every((p) => p.ready)) {
      return { error: ERR.BAD_REQUEST, message: '还有玩家未就绪' };
    }
    room.status = 'playing';
    const gameTime = room.config?.gameTime ?? 0;
    room.game = game.create(this._gameSeats(room), {
      timeLimit: room.config?.timeLimit ?? config.moveTimeLimit,
      gameTime,
    });
    this._initClocks(room.game, gameTime);
    room.drawCooldownAt = {}; // userId -> 可再次提和的最低 moveCount
    this._clearTurnTimer(room);
    this._clearUndoRequest(room);
    this._clearDrawRequest(room);
    this._scheduleAiMove(room); // 先手方是电脑（对方先手设置）时立即安排思考
    this._scheduleTurnTimeout(room);
    logger.info('room', '对局开始', { roomId: room.id, players: room.players.map((p) => p.name) });
    this._broadcastRoom(room);
    this.io.sendToMany(
      room.players.map((p) => p.id),
      { type: EVT.GAME_START, roomId: room.id, game: game.serialize(room.game) }
    );
    // 观战者同步棋盘
    if (room.spectators.length > 0) {
      this.io.sendToMany(
        room.spectators.map((s) => s.id),
        { type: EVT.GAME_STATE, roomId: room.id, game: game.serialize(room.game) }
      );
    }
    return { ok: true, roomId: room.id };
  }

  /** 初始化局时时钟（每人包干剩余毫秒） */
  _initClocks(gameState: GameState | null | undefined, gameTimeSec: number): void {
    if (!gameState) return;
    if (!gameTimeSec || gameTimeSec <= 0) {
      gameState.clocks = null;
      return;
    }
    const ms = gameTimeSec * 1000;
    gameState.clocks = {};
    for (const p of gameState.players) {
      gameState.clocks[p.id] = ms;
    }
  }

  /** 扣减当前走子方已用局时（在落子或超时判定前调用） */
  _deductActiveClock(room: Room): void {
    const g = room.game;
    if (!g?.clocks || g.over) return;
    const pid = g.players[g.turn]?.id;
    if (!pid || g.clocks[pid] == null) return;
    const elapsed = Date.now() - (g.turnStartedAt || Date.now());
    g.clocks[pid] = Math.max(0, g.clocks[pid] - elapsed);
  }

  /** 踢人（房主） */
  kick(userId: string, targetId: string): Result {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (room.ownerId !== userId) return { error: ERR.NOT_OWNER, message: '只有房主可以踢人' };
    if (targetId === userId) return { error: ERR.BAD_REQUEST, message: '不能踢自己' };
    const target = [...room.players, ...room.spectators].find((m) => m.id === targetId);
    if (!target) return { error: ERR.NOT_FOUND, message: '目标不在房间中' };
    this._removeFromRoom(room, targetId);
    this.io.send(targetId, { type: EVT.ROOM_LEFT, roomId: room.id, kicked: true });
    return { ok: true };
  }

  /** 落子 */
  applyMove(userId: string, move: unknown): Result {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (!room.game || room.status !== 'playing') {
      return { error: ERR.GAME_NOT_STARTED, message: '对局尚未开始' };
    }
    // 落子前扣减走子方局时
    this._deductActiveClock(room);
    const game = getGame(room.gameType);
    if (!game) return { error: ERR.BAD_REQUEST, message: '未知的游戏类型' };
    const result = game.applyMove(room.game, userId, move);
    if (!result.ok) {
      return { error: ERR.INVALID_MOVE, message: result.error };
    }
    const snapshot = game.serialize(room.game);
    if (result.gameOver) {
      this._finishGame(room, result);
      // GAME_OVER 消息中包含最终棋盘
      this.io.sendToMany(this._memberIds(room), {
        type: EVT.GAME_OVER,
        roomId: room.id,
        winnerId: result.winnerId,
        winnerName: result.winnerId
          ? room.players.find((p) => p.id === result.winnerId)?.name || ''
          : '',
        reason: result.reason,
        isDraw: result.isDraw,
        game: snapshot,
      });
      this._broadcastRoom(room);
    } else {
      // 本回合计时结束，为下一位玩家重新计时；清除未决的悔棋/求和请求
      // 人机模式：若轮到电脑则触发 AI 走子（AI 回合不参与超时）
      this._clearTurnTimer(room);
      this._clearUndoRequest(room);
      this._clearDrawRequest(room);
      this._scheduleAiMove(room);
      this._scheduleTurnTimeout(room);
      this.io.sendToMany(this._memberIds(room), {
        type: EVT.GAME_MOVE,
        roomId: room.id,
        playerId: userId,
        move: room.game.lastMove,
        turn: room.game.turn,
        game: snapshot,
      });
    }
    return { ok: true };
  }

  // ---------------- 悔棋 ----------------

  /** 请求悔棋（撤销最后一步，需对方同意） */
  undoRequest(userId: string): Result {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (!room.game || room.status !== 'playing' || room.game.over) {
      return { error: ERR.GAME_NOT_STARTED, message: '对局尚未开始或已结束' };
    }
    const me = room.players.find((p) => p.id === userId);
    if (!me) return { error: ERR.BAD_REQUEST, message: '观战者不能请求悔棋' };
    if (room.game.moves.length === 0) {
      return { error: ERR.BAD_REQUEST, message: '还没有棋步可撤销' };
    }
    if (room.pendingUndo) {
      return { error: ERR.BAD_REQUEST, message: '已有悔棋请求在等待回应' };
    }
    const opponent = room.players.find((p) => p.id !== userId);
    if (!opponent) return { error: ERR.BAD_REQUEST, message: '找不到对手' };

    // 人机模式：电脑无需同意，直接撤销最后一步
    if (room.mode === 'ai') {
      const game = getGame(room.gameType);
      if (!game) return { error: ERR.BAD_REQUEST, message: '未知的游戏类型' };
      const result = game.undoLastMove(room.game);
      if (!result.ok) return { error: ERR.BAD_REQUEST, message: result.error };
      this._clearTurnTimer(room);
      this._clearAiTimer(room);
      this._scheduleAiMove(room);
      this._scheduleTurnTimeout(room);
      this.io.sendToMany(this._memberIds(room), {
        type: EVT.UNDO_DONE,
        roomId: room.id,
        byName: '电脑',
        game: game.serialize(room.game),
      });
      this._broadcastRoom(room);
      logger.info('game', '人机悔棋成功', { roomId: room.id, undone: result.notation });
      return { ok: true };
    }

    room.pendingUndo = {
      byId: userId,
      byName: me.name,
      timer: setTimeout(() => {
        // 对方 30 秒未回应，请求作废
        const cur = this.rooms.get(room.id);
        if (cur?.pendingUndo && cur.pendingUndo.byId === userId) {
          this._clearUndoRequest(cur);
          this.io.send(userId, { type: EVT.UNDO_CANCELLED, reason: '等待超时，悔棋请求已取消' });
        }
      }, config.undoRequestTimeout),
    };
    this.io.send(opponent.id, {
      type: EVT.UNDO_REQUESTED,
      byUserId: userId,
      byName: me.name,
    });
    this.io.send(userId, { type: EVT.UNDO_REQUESTED, byUserId: userId, byName: me.name, mine: true });
    logger.info('game', '悔棋请求', { roomId: room.id, by: me.name });
    return { ok: true };
  }

  /** 回应悔棋请求 */
  undoRespond(userId: string, agree: boolean): Result {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (!room.pendingUndo) return { error: ERR.BAD_REQUEST, message: '当前没有悔棋请求' };
    if (room.pendingUndo.byId === userId) {
      return { error: ERR.BAD_REQUEST, message: '不能回应自己的悔棋请求' };
    }
    const responder = room.players.find((p) => p.id === userId);
    if (!responder) return { error: ERR.BAD_REQUEST, message: '观战者不能回应悔棋' };

    const request = room.pendingUndo;
    this._clearUndoRequest(room);

    if (!agree) {
      this.io.send(request.byId, { type: EVT.UNDO_RESPONSE, agree: false, byName: responder.name });
      logger.info('game', '悔棋被拒绝', { roomId: room.id, by: responder.name });
      return { ok: true };
    }

    // 同意：撤销最后一步
    const game = getGame(room.gameType);
    if (!game || !room.game) {
      this.io.send(request.byId, { type: EVT.UNDO_RESPONSE, agree: false, byName: responder.name, reason: '未知的游戏类型' });
      return { error: ERR.BAD_REQUEST, message: '未知的游戏类型' };
    }
    const result = game.undoLastMove(room.game);
    if (!result.ok) {
      this.io.send(request.byId, { type: EVT.UNDO_RESPONSE, agree: false, byName: responder.name, reason: result.error });
      return { error: ERR.BAD_REQUEST, message: result.error };
    }
    this._clearTurnTimer(room);
    this._clearAiTimer(room);
    this._scheduleAiMove(room);
    this._scheduleTurnTimeout(room);
    this.io.sendToMany(this._memberIds(room), {
      type: EVT.UNDO_DONE,
      roomId: room.id,
      byName: responder.name,
      game: game.serialize(room.game!),
    });
    this._broadcastRoom(room);
    logger.info('game', '悔棋成功', { roomId: room.id, by: responder.name, undone: result.notation });
    return { ok: true };
  }

  _clearUndoRequest(room: Room): void {
    if (room.pendingUndo?.timer) {
      clearTimeout(room.pendingUndo.timer);
    }
    room.pendingUndo = null;
  }

  // ---------------- 求和 ----------------

  /** 提和（需对方同意；人机房不支持求和） */
  offerDraw(userId: string): Result {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (!room.game || room.status !== 'playing' || room.game.over) {
      return { error: ERR.GAME_NOT_STARTED, message: '对局尚未开始或已结束' };
    }
    if (room.mode === 'ai') {
      return { error: ERR.BAD_REQUEST, message: '人机对战不支持求和' };
    }
    const me = room.players.find((p) => p.id === userId);
    if (!me) return { error: ERR.BAD_REQUEST, message: '观战者不能求和' };
    if (room.pendingDraw) {
      return { error: ERR.BAD_REQUEST, message: '已有求和请求在等待回应' };
    }
    if (room.pendingUndo) {
      return { error: ERR.BAD_REQUEST, message: '请先处理悔棋请求' };
    }
    const cooldownAt = room.drawCooldownAt?.[userId] ?? 0;
    if (room.game.moves.length < cooldownAt) {
      const left = cooldownAt - room.game.moves.length;
      return { error: ERR.BAD_REQUEST, message: `求和被拒后需再走 ${left} 步才能再次提和` };
    }
    const opponent = room.players.find((p) => p.id !== userId);
    if (!opponent) return { error: ERR.BAD_REQUEST, message: '找不到对手' };

    room.pendingDraw = {
      byId: userId,
      byName: me.name,
      timer: setTimeout(() => {
        const cur = this.rooms.get(room.id);
        if (cur?.pendingDraw && cur.pendingDraw.byId === userId) {
          this._clearDrawRequest(cur);
          this.io.send(userId, { type: EVT.DRAW_RESPONSE, agree: false, byName: '系统', reason: '等待超时，求和已取消' });
        }
      }, config.undoRequestTimeout),
    };
    this.io.send(opponent.id, {
      type: EVT.DRAW_REQUESTED,
      byUserId: userId,
      byName: me.name,
    });
    this.io.send(userId, { type: EVT.DRAW_REQUESTED, byUserId: userId, byName: me.name, mine: true });
    logger.info('game', '求和请求', { roomId: room.id, by: me.name });
    return { ok: true };
  }

  /** 回应求和 */
  respondDraw(userId: string, agree: boolean): Result {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (!room.pendingDraw) return { error: ERR.BAD_REQUEST, message: '当前没有求和请求' };
    if (room.pendingDraw.byId === userId) {
      return { error: ERR.BAD_REQUEST, message: '不能回应自己的求和' };
    }
    const responder = room.players.find((p) => p.id === userId);
    if (!responder) return { error: ERR.BAD_REQUEST, message: '观战者不能回应求和' };

    const request = room.pendingDraw;
    this._clearDrawRequest(room);

    if (!agree) {
      if (!request || !room.game) return { ok: true };
      room.drawCooldownAt = room.drawCooldownAt || {};
      room.drawCooldownAt[request.byId] = room.game.moves.length + DRAW_COOLDOWN_PLIES;
      this.io.send(request.byId, { type: EVT.DRAW_RESPONSE, agree: false, byName: responder.name });
      logger.info('game', '求和被拒绝', { roomId: room.id, by: responder.name });
      return { ok: true };
    }

    return this._finalizeDraw(room, '双方协商和棋');
  }

  _finalizeDraw(room: Room, reason: string): Result {
    const game = getGame(room.gameType);
    if (!game?.agreeDraw || !room.game) {
      return { error: ERR.BAD_REQUEST, message: '当前游戏不支持求和' };
    }
    const result = game.agreeDraw(room.game, reason);
    if (!result.ok) return { error: ERR.BAD_REQUEST, message: result.error };
    this._finishGame(room, result);
    this.io.sendToMany(this._memberIds(room), {
      type: EVT.GAME_OVER,
      roomId: room.id,
      winnerId: null,
      winnerName: '',
      reason: result.reason,
      isDraw: true,
      game: game.serialize(room.game!),
    });
    this._broadcastRoom(room);
    logger.info('game', '协商和棋', { roomId: room.id, reason });
    return { ok: true };
  }

  _clearDrawRequest(room: Room): void {
    if (room.pendingDraw?.timer) {
      clearTimeout(room.pendingDraw.timer);
    }
    room.pendingDraw = null;
  }

  // ---------------- 走子倒计时（超时判负） ----------------

  _scheduleTurnTimeout(room: Room): void {
    if (!room.game || room.game.over) return;
    // 人机对局：双方均不限制走子时间（电脑自己走子，玩家不限时）
    if (room.mode === 'ai') {
      this._clearTurnTimer(room);
      return;
    }
    const stepMs = (room.game.timeLimit || config.moveTimeLimit) * 1000;
    let limitMs = stepMs;
    if (room.game.clocks) {
      const current = room.game.players[room.game.turn];
      const clockMs = current ? room.game.clocks[current.id] : null;
      if (clockMs != null) limitMs = Math.min(stepMs, Math.max(0, clockMs));
    }
    this._clearTurnTimer(room);
    room.turnTimer = setTimeout(() => {
      const cur = this.rooms.get(room.id);
      if (!cur || !cur.game || cur.game.over || cur.status !== 'playing') return;
      const timedOut = cur.game.players[cur.game.turn];
      if (!timedOut) return;
      this._deductActiveClock(cur);
      const game = getGame(cur.gameType);
      if (!game) return;
      const result = game.surrender(cur.game, timedOut.id);
      if (!result.ok) return;
      const clockLeft = cur.game.clocks?.[timedOut.id];
      if (clockLeft != null && clockLeft <= 0) {
        result.reason = `${timedOut.name} 局时用完，超时判负`;
      } else {
        result.reason = `${timedOut.name} 走子超时`;
      }
      this._finishGame(cur, result);
      this.io.sendToMany(this._memberIds(cur), {
        type: EVT.GAME_OVER,
        roomId: cur.id,
        winnerId: result.winnerId,
        winnerName: result.winnerId
          ? cur.players.find((p) => p.id === result.winnerId)?.name || ''
          : '',
        reason: result.reason,
        isDraw: result.isDraw,
        game: game.serialize(cur.game),
      });
      this._broadcastRoom(cur);
      logger.info('game', '超时判负', {
        roomId: cur.id,
        userId: timedOut.id,
        name: timedOut.name,
        limitMs,
        reason: result.reason,
      });
    }, limitMs);
  }

  // ---------------- 人机模式：电脑走子 ----------------

  /**
   * 计算当前轮到一方的推荐走法（不落子）。
   * 象棋优先 eleeye 引擎（走法经合法走法表校验，非法/引擎不可用时回退内置 AI）；
   * 五子棋用启发式 AI。
   * @returns {{ move: {from,to}, engine: string } | null}
   */
  async _computeBestMove(room: Room, opts: { forceStrong?: boolean } = {}): Promise<{ move: { from?: { x: number; y: number }; to?: { x: number; y: number }; x?: number; y?: number }; engine: string } | null> {
    const game = getGame(room.gameType);
    const state = room.game;
    if (!game || !state || state.over) return null;

    if (room.gameType === 'gomoku') {
      const color = state.turn === 0 ? 'b' : 'w';
      const move = gomokuBestMove(state.board, color);
      return move ? { move, engine: 'gomoku-ai' } : null;
    }

    const color = state.turn === 0 ? 'r' : 'b';
    const legal = genLegalMoves(state.board, color);
    if (legal.length === 0) return null;
    const isLegal = (mv: { from: { x: number; y: number }; to: { x: number; y: number } }) => legal.some(
      (m) => m.from.x === mv.from.x && m.from.y === mv.from.y
          && m.to.x === mv.to.x && m.to.y === mv.to.y
    );

    // 提示(hint)用强引擎；电脑走子用房间所选难度
    const level = opts.forceStrong
      ? { engine: 'eleeye' as const, thinkMs: config.aiThinkMs, depth: undefined as number | undefined, randomTopK: undefined as number | undefined }
      : (AI_LEVELS[room.aiLevel || DEFAULT_AI_LEVEL] || AI_LEVELS[DEFAULT_AI_LEVEL]);
    let move: { from: { x: number; y: number }; to: { x: number; y: number } } | { x: number; y: number } | null = null;
    let engine = 'xiangqi-ai';
    try {
      if (level.engine === 'eleeye') {
        const engineMove = await ucciEngine.getBestMove(state.board, color, level.thinkMs);
        if (engineMove && isLegal(engineMove)) {
          move = engineMove;
          engine = 'eleeye';
        }
      }
    } catch (err) {
      logger.warn('game', '引擎调用异常，回退内置 AI', { roomId: room.id, error: (err as Error).message });
    }
    if (!move) {
      const depth = level.depth ?? 3;
      const topK = level.randomTopK ?? 1;
      move = xiangqiBestMove(state.board, color, depth, { randomTopK: topK });
      engine = 'xiangqi-ai';
    }
    return move && isLegal(move) ? { move, engine } : null;
  }

  // ---------------- 走法提示 ----------------

  /**
   * 为请求方计算一步提示走法（私有下发 s.hint，不广播、不落子）
   * 仅中国象棋支持（eleeye 引擎）；五子棋等不支持
   */
  async hintFor(userId: string): Promise<Result<{ move: unknown; engine: string }>> {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (!room.game || room.status !== 'playing') {
      return { error: ERR.GAME_NOT_STARTED, message: '对局尚未开始' };
    }
    if (room.game.over) return { error: ERR.BAD_REQUEST, message: '对局已结束' };
    if (room.gameType !== 'xiangqi') {
      return { error: ERR.BAD_REQUEST, message: '当前游戏不支持提示' };
    }
    // 中国象棋：players[0] 恒为先手红方，players[1] 为黑方；禁止黑方使用 AI 提示
    if (room.game.turn === 1) {
      return { error: ERR.BAD_REQUEST, message: '中国象棋黑方不可使用 AI 提示' };
    }
    const current = room.game.players[room.game.turn];
    if (!current || current.id !== userId) {
      return { error: ERR.NOT_YOUR_TURN, message: '还没轮到你，无法请求提示' };
    }
    if (room.hintPending) {
      return { error: ERR.BAD_REQUEST, message: '正在计算提示，请稍候' };
    }
    room.hintPending = true;
    try {
      const pick = await this._computeBestMove(room, { forceStrong: true });
      if (!pick) return { error: ERR.BAD_REQUEST, message: '暂时无法给出提示' };
      this.io.send(userId, {
        type: EVT.HINT,
        roomId: room.id,
        move: pick.move,
        engine: pick.engine,
      });
      logger.info('game', '走法提示', { roomId: room.id, userId, engine: pick.engine, move: pick.move });
      return { ok: true, move: pick.move, engine: pick.engine };
    } finally {
      room.hintPending = false;
    }
  }

  /** 若当前轮到电脑，安排一次 AI 走子（带思考延迟） */
  _scheduleAiMove(room: Room): void {
    if (room.mode !== 'ai' || !room.game || room.game.over) return;
    if (room.game.players[room.game.turn]?.id !== room.aiId) return;
    this._clearAiTimer(room);
    const delay = AI_THINK_MIN + Math.floor(Math.random() * (AI_THINK_MAX - AI_THINK_MIN));
    room.aiTimer = setTimeout(() => this._aiMove(room), delay);
    logger.debug('game', '电脑思考中', { roomId: room.id, delay });
  }

  _clearAiTimer(room: Room): void {
    if (room.aiTimer) {
      clearTimeout(room.aiTimer);
      room.aiTimer = null;
    }
  }

  /** 电脑走一步棋（象棋优先 eleeye，五子棋用启发式 AI） */
  async _aiMove(room: Room): Promise<void> {
    const cur = this.rooms.get(room.id);
    if (!cur || !cur.game || cur.game.over || cur.status !== 'playing') return;
    if (cur.game.players[cur.game.turn]?.id !== cur.aiId) return;

    const game = getGame(cur.gameType);
    if (!game) return;
    const started = Date.now();
    const pick = await this._computeBestMove(cur);
    if (!pick) {
      logger.warn('game', '电脑无合法走法', { roomId: cur.id });
      return;
    }
    const result = game.applyMove(cur.game, cur.aiId, pick.move);
    if (!result || !result.ok) {
      logger.warn('game', '电脑走子失败', { roomId: cur.id, move: pick.move, error: result?.error });
      return;
    }
    const engineName = pick.engine;
    const cost = Date.now() - started;
    logger.info('game', '电脑走子', { roomId: cur.id, move: pick.move, notation: cur.game.lastMove?.notation, ms: cost, engine: engineName });

    if (result.gameOver) {
      this._finishGame(cur, result);
      this.io.sendToMany(this._memberIds(cur), {
        type: EVT.GAME_OVER,
        roomId: cur.id,
        winnerId: result.winnerId,
        winnerName: result.winnerId
          ? cur.players.find((p) => p.id === result.winnerId)?.name || ''
          : '',
        reason: result.reason,
        isDraw: result.isDraw,
        game: game.serialize(cur.game),
      });
      this._broadcastRoom(cur);
      return;
    }
    // 电脑走完，轮到玩家：重新计时并广播
    this._clearTurnTimer(cur);
    this._clearUndoRequest(cur);
    this._clearDrawRequest(cur);
    this._scheduleTurnTimeout(cur);
    this._scheduleAiMove(cur);
    this.io.sendToMany(this._memberIds(cur), {
      type: EVT.GAME_MOVE,
      roomId: cur.id,
      playerId: cur.aiId,
      move: cur.game.lastMove,
      turn: cur.game.turn,
      game: game.serialize(cur.game),
    });
  }

  _clearTurnTimer(room: Room): void {
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }
  }

  /** 认输 */
  surrender(userId: string): Result {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (!room.game || room.status !== 'playing') {
      return { error: ERR.GAME_NOT_STARTED, message: '对局尚未开始' };
    }
    const game = getGame(room.gameType);
    if (!game) return { error: ERR.BAD_REQUEST, message: '未知的游戏类型' };
    const result = game.surrender(room.game, userId);
    if (!result.ok) return { error: ERR.BAD_REQUEST, message: result.error };
    this._finishGame(room, result);
    this.io.sendToMany(this._memberIds(room), {
      type: EVT.GAME_OVER,
      roomId: room.id,
      winnerId: result.winnerId,
      winnerName: result.winnerId
        ? room.players.find((p) => p.id === result.winnerId)?.name || ''
        : '',
      reason: result.reason,
      isDraw: result.isDraw,
      game: game.serialize(room.game),
    });
    this._broadcastRoom(room);
    return { ok: true };
  }

  /** 对局结束统一处理：计分、记录历史 */
  _finishGame(room: Room, result: { winnerId?: string | null; isDraw?: boolean; reason?: string }): unknown {
    const game = getGame(room.gameType);
    if (!game || !room.game) return null;
    const snapshot = game.serialize(room.game);
    this._clearTurnTimer(room);
    this._clearUndoRequest(room);
    this._clearDrawRequest(room);
    this._clearAiTimer(room);
    const playerIds = room.players.map((p) => p.id);
    // 人机对局：电脑不计入排行榜与战绩（电脑用户不存在于 store，applyMatchResult 会忽略）
    userApi.applyMatchResult(playerIds.filter((id) => id !== AI_USER_ID), result.winnerId, result.isDraw);
    userApi.recordMatch({
      gameType: room.gameType,
      // 必须按对局席位顺序记录（players[0] 恒为先手方：象棋红方/五子棋黑方）。
      // room.players 是房间座位顺序（房主恒在前），"对方先手"时与席位相反，不能直接存。
      players: room.game?.players ?? room.players,
      winnerId: result.winnerId,
      isDraw: result.isDraw,
      reason: result.reason,
      moves: room.game.moves,
    });
    logger.info('game', '对局结束', {
      roomId: room.id,
      game: room.gameType,
      moves: room.game.moves.length,
      winnerId: result.winnerId,
      isDraw: result.isDraw,
      reason: result.reason,
      players: room.players.map((p) => ({ id: p.id, name: p.name })),
    });
    // 更新所有成员的评分/战绩显示
    const users = this._memberIds(room)
      .map((pid) => userApi.getUserById(pid))
      .filter((u): u is NonNullable<typeof u> => !!u);
    if (users.length > 0) {
      this.io.sendToMany(
        users.map((u) => u.id),
        { type: EVT.RATING_UPDATE, users }
      );
    }
    return snapshot;
  }

  /** 重开一局（房主，且上局已结束） */
  restart(userId: string): Result<{ roomId: string }> {
    const room = this._roomOf(userId);
    if (!room) return { error: ERR.NOT_IN_ROOM, message: '你不在房间中' };
    if (room.ownerId !== userId) return { error: ERR.NOT_OWNER, message: '只有房主可以重开' };
    if (!room.game || !room.game.over) {
      return { error: ERR.BAD_REQUEST, message: '对局尚未结束' };
    }
    const game = getGame(room.gameType);
    if (!game) return { error: ERR.BAD_REQUEST, message: '未知的游戏类型' };
    const gameTime = room.config?.gameTime ?? 0;
    room.game = game.create(this._gameSeats(room), {
      timeLimit: room.config?.timeLimit ?? config.moveTimeLimit,
      gameTime,
    });
    this._initClocks(room.game, gameTime);
    room.drawCooldownAt = {};
    for (const p of room.players) p.ready = false;
    // 电脑玩家保持就绪
    if (room.mode === 'ai') {
      const ai = room.players.find((p) => p.id === room.aiId);
      if (ai) ai.ready = true;
    }
    this._clearTurnTimer(room);
    this._clearUndoRequest(room);
    this._clearDrawRequest(room);
    this._clearAiTimer(room);
    this._scheduleAiMove(room);
    this._scheduleTurnTimeout(room);
    this._broadcastRoom(room);
    this.io.sendToMany(this._memberIds(room), {
      type: EVT.GAME_RESTARTED,
      roomId: room.id,
      game: game.serialize(room.game),
    });
    return { ok: true, roomId: room.id };
  }

  /** 对局中玩家离开/掉线判负 */
  _forfeit(room: Room, loserId: string, _reason: string): void {
    const game = getGame(room.gameType);
    if (!game || !room.game) return;
    const result = game.surrender(room.game, loserId);
    if (!result.ok) return;
    this._finishGame(room, result);
    this.io.sendToMany(this._memberIds(room), {
      type: EVT.GAME_OVER,
      roomId: room.id,
      winnerId: result.winnerId,
      winnerName: result.winnerId
        ? room.players.find((p) => p.id === result.winnerId)?.name || ''
        : '',
      reason: result.reason,
      isDraw: result.isDraw,
      game: game.serialize(room.game),
    });
  }

  // ---------- 工具 ----------

  _roomOf(userId: string): Room | null {
    const roomId = this.userRoom.get(userId);
    if (!roomId) return null;
    return this.rooms.get(roomId) || null;
  }

  _memberIds(room: Room): string[] {
    return [...room.players.map((p) => p.id), ...room.spectators.map((s) => s.id)];
  }

  /** 用户是否在房间中 */
  inRoom(userId: string): boolean {
    return this.userRoom.has(userId);
  }

  /** 用户当前房间视图（供恢复用） */
  currentRoomView(userId: string): RoomView | null {
    const room = this._roomOf(userId);
    return room ? this._roomViewFor(room, userId) : null;
  }

  get roomCount() {
    return this.rooms.size;
  }
}
