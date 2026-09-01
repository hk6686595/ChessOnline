/**
 * 对战平台共享类型
 */

export type GameTypeId = 'xiangqi' | 'gomoku';
export type SideColor = 'r' | 'b';
export type GomokuColor = 'b' | 'w';
export type RoomStatus = 'waiting' | 'playing';
export type RoomMode = 'ai' | 'pvp';
export type FirstMove = 'owner' | 'opponent';
export type FriendStatus = 'pending' | 'accepted';
export type ChatScope = 'lobby' | 'room';

export interface Coord {
  x: number;
  y: number;
}

export interface PartialCoord {
  x?: number;
  y?: number;
}

export interface Move {
  from: Coord;
  to: Coord;
}

export interface PlayerRef {
  id: string;
  name: string;
}

export interface PublicUser {
  id: string;
  name: string;
  isGuest: boolean;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  avatar: string;
  createdAt: number;
}

export interface UserRecord extends PublicUser {
  passwordHash?: string;
  salt?: string;
  lastSeen: number;
}

export interface MatchPlayer {
  id: string;
  name: string;
  rating?: number;
}

export interface MatchMove {
  player: string;
  from?: PartialCoord;
  to?: PartialCoord;
  x?: number;
  y?: number;
  captured?: string | null;
  notation?: string | null;
  gaveCheck?: boolean;
  _msc?: number;
}

export interface MatchRecord {
  id: number;
  ts: number;
  gameType: string;
  players: MatchPlayer[];
  winnerId: string | null;
  isDraw: boolean;
  reason: string | null;
  moveCount: number;
  moves: MatchMove[] | null;
  favoritedBy: string[];
  deletedBy: string[];
}

export interface MatchView {
  id: number;
  ts: number;
  gameType: string;
  result: string;
  moveCount: number;
  reason: string | null;
  opponent: { id: string; name: string; rating?: number } | null;
  players: MatchPlayer[];
  favorited: boolean;
}

export interface FriendRelation {
  id: number | string;
  userA: string;
  userB: string;
  status: FriendStatus;
  requester: string;
  createdAt: number;
}

export interface OfflineMessage {
  id: number;
  fromId: string;
  fromName: string;
  toId: string;
  text: string;
  ts: number;
}

export interface StoreData {
  users: Record<string, UserRecord>;
  matches: MatchRecord[];
  friends: FriendRelation[];
  offlineMessages: OfflineMessage[];
  nextUserId: number;
  nextMatchId: number;
  nextFriendId: number;
  nextOfflineMsgId: number;
}

export interface GamePlayer {
  id: string;
  name: string;
}

export interface GameMove {
  player: string;
  from?: PartialCoord;
  to?: PartialCoord;
  x?: number;
  y?: number;
  captured?: string | null;
  notation?: string | null;
  gaveCheck?: boolean;
  _msc?: number;
}

export interface LastMove {
  from?: PartialCoord;
  to?: PartialCoord;
  x?: number;
  y?: number;
  notation?: string | null;
}

export interface GameState {
  type: string;
  board: (string | null)[][];
  turn: number;
  players: GamePlayer[];
  moves: GameMove[];
  lastMove: LastMove | null;
  startedAt: number;
  timeLimit: number;
  gameTime: number;
  clocks: Record<string, number> | null;
  turnStartedAt: number;
  over: boolean;
  winnerId: string | null;
  isDraw: boolean;
  reason: string | null;
  check?: string | null;
  captured?: { code: string; at: Coord }[];
  posHistory?: string[];
  movesSinceCapture?: number;
  winLine?: Coord[] | null;
}

export interface ApplyMoveResult {
  ok: boolean;
  error?: string;
  gameOver?: boolean;
  winnerId?: string | null;
  isDraw?: boolean;
  reason?: string;
  nextTurn?: number;
  check?: string | null;
}

export interface UndoResult {
  ok: boolean;
  error?: string;
  turn?: number;
  notation?: string | null;
}

export interface GameSnapshot {
  type: string;
  cols: number;
  rows: number;
  board: (string | null)[][];
  turn: number;
  players: GamePlayer[];
  moveCount: number;
  moves: GameMove[];
  timeLimit: number;
  gameTime: number;
  clocks: Record<string, number> | null;
  turnStartedAt: number;
  lastMove: LastMove | null;
  check: string | null;
  captured: { code: string; at: Coord }[];
  over: boolean;
  winnerId: string | null;
  isDraw: boolean;
  reason: string | null;
  movesSinceCapture?: number;
  winLine?: Coord[] | null;
}

export interface GameModule {
  type: string;
  name: string;
  minPlayers: number;
  maxPlayers: number;
  supportsSpectate: boolean;
  create(players: PlayerRef[], opts?: { timeLimit?: number; gameTime?: number }): GameState;
  applyMove(state: GameState, playerId: string, move: unknown): ApplyMoveResult;
  serialize(state: GameState): GameSnapshot;
  parseMove(raw: unknown): unknown;
  undoLastMove(state: GameState): UndoResult;
  surrender(state: GameState, playerId: string): ApplyMoveResult;
  agreeDraw(state: GameState, reason?: string): ApplyMoveResult;
}

export interface GameTypeInfo {
  type: string;
  name: string;
  minPlayers: number;
  maxPlayers: number;
  supportsSpectate: boolean;
}

export interface RoomSeat {
  id: string;
  name: string;
  ready: boolean;
  online: boolean;
}

export interface RoomConfig {
  timeLimit: number | null;
  gameTime: number;
  firstMove: FirstMove;
}

export interface PendingRequest {
  byId: string;
  byName: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface Room {
  id: string;
  inviteCode: string;
  name: string;
  gameType: string;
  maxPlayers: number;
  password: string | null;
  private: boolean;
  mode: RoomMode;
  aiId: string | null;
  aiLevel: string | null;
  ownerId: string;
  owner?: { name: string };
  status: RoomStatus;
  config: RoomConfig;
  players: RoomSeat[];
  spectators: RoomSeat[];
  game: GameState | null;
  createdAt: number;
  drawCooldownAt?: Record<string, number>;
  pendingUndo?: PendingRequest | null;
  pendingDraw?: PendingRequest | null;
  hintPending?: boolean;
  turnTimer?: ReturnType<typeof setTimeout> | null;
  aiTimer?: ReturnType<typeof setTimeout> | null;
}

export interface PublicRoom {
  id: string;
  name: string;
  gameType: string;
  gameName: string;
  hasPassword: boolean;
  status: RoomStatus;
  playerCount: number;
  maxPlayers: number;
  spectatorCount: number;
  ownerName: string;
  createdAt: number;
}

export interface RoomView {
  id: string;
  name: string;
  gameType: string;
  gameName: string;
  hasPassword: boolean;
  status: RoomStatus;
  ownerId: string;
  maxPlayers: number;
  mode: RoomMode;
  players: Array<{
    id: string;
    name: string;
    isOwner: boolean;
    ready: boolean;
    online: boolean;
  }>;
  spectators: Array<{ id: string; name: string; online: boolean }>;
  config: { timeLimit: number; gameTime: number; firstMove: FirstMove };
  createdAt: number;
  game?: GameSnapshot;
}

export interface Io {
  send(userId: string, msg: Record<string, unknown>): void;
  sendToMany(userIds: string[], msg: Record<string, unknown>): void;
  broadcastAll(msg: Record<string, unknown>): void;
}

export interface QueueEntry {
  userId: string;
  name: string;
  gameType: string;
  rating: number;
  queuedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ChatMessage {
  from: string;
  fromId?: string;
  text: string;
  ts: number;
  scope?: ChatScope;
}

export interface RankingRow extends PublicUser {
  rank: number;
}

export type Ok<T extends object = object> = { ok: true } & T;
export type Err = { ok?: false; error: string; message: string };
export type Result<T extends object = object> = {
  ok?: boolean;
  error?: string;
  message?: string;
} & Partial<T>;

export interface SessionInfo {
  userId: string;
  expiresAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __sessions: Map<string, SessionInfo> | undefined;
  // eslint-disable-next-line no-var
  var __userTokens: Map<string, Set<string>> | undefined;
  // eslint-disable-next-line no-var
  var __onlineUsers: number | undefined;
}

export {};
