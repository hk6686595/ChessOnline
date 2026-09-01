/**
 * 五子棋（Gomoku）规则引擎
 *
 * 棋盘坐标：x ∈ [0,14]（列，左→右），y ∈ [0,14]（行，上→下）
 *   15×15 标准棋盘，黑先白后（players[0] 执黑）
 *   棋子编码：board[y][x] = 'b' 黑 / 'w' 白 / null 空
 *   自由规则：横/竖/斜任意方向连成五子（含长连）即胜；棋盘下满为和棋
 *
 * 走子格式：{ x, y }（也接受 { to: {x,y} } 以便与象棋客户端兼容）
 */
import type {
  ApplyMoveResult,
  Coord,
  GameSnapshot,
  GameState,
  LastMove,
  PlayerRef,
  UndoResult,
} from '../types.js';

export const type = 'gomoku';
export const name = '五子棋';
export const minPlayers = 2;
export const maxPlayers = 2;
export const supportsSpectate = true;

export const COLS = 15;
export const ROWS = 15;
export const WIN_LEN = 5;

type Board = (string | null)[][];
type Color = 'b' | 'w';

const BLACK = 'b';
const WHITE = 'w';
const COL_LETTERS = 'ABCDEFGHIJKLMNO';
const DIRS = [
  [1, 0],  // 横
  [0, 1],  // 竖
  [1, 1],  // 斜 ↘
  [1, -1], // 斜 ↗
];

export function colorOfTurn(turn: number): Color {
  return turn === 0 ? BLACK : WHITE;
}

export function colorName(color: string): string {
  return color === BLACK ? '黑' : '白';
}

export function initialBoard(): Board {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

export function create(players: PlayerRef[], opts: { timeLimit?: number; gameTime?: number } = {}): GameState {
  return {
    type,
    board: initialBoard(),
    turn: 0,
    players: players.map((p) => ({ id: p.id, name: p.name })),
    moves: [],
    lastMove: null,
    winLine: null,
    startedAt: Date.now(),
    timeLimit: opts.timeLimit ?? 60,
    gameTime: opts.gameTime ?? 0,
    clocks: null,
    turnStartedAt: Date.now(),
    over: false,
    winnerId: null,
    isDraw: false,
    reason: null,
  };
}

export function parseMove(raw: unknown): { error: string } | Coord {
  if (typeof raw !== 'object' || raw === null) return { error: '非法走法' };
  const rec = raw as { x?: number; y?: number; to?: { x?: number; y?: number } };
  const src =
    Number.isInteger(Number(rec.x)) && Number.isInteger(Number(rec.y))
      ? rec
      : rec.to && typeof rec.to === 'object'
        ? rec.to
        : null;
  if (!src) return { error: '走法需包含 x 和 y' };
  const x = Number(src.x);
  const y = Number(src.y);
  if (![x, y].every((v) => Number.isInteger(v))) return { error: '坐标必须为整数' };
  if (!inBoard(x, y)) return { error: '坐标超出棋盘' };
  return { x, y };
}

export function inBoard(x: number, y: number): boolean {
  return x >= 0 && x < COLS && y >= 0 && y < ROWS;
}

/**
 * 从 (x,y) 沿四个方向统计连子，若 ≥5 则返回连成一线的格子
 */
export function findWinLine(board: Board, x: number, y: number): Coord[] | null {
  const color = board[y]?.[x];
  if (!color) return null;
  for (const [dx, dy] of DIRS) {
    const cells = [{ x, y }];
    for (const sign of [1, -1]) {
      let cx = x + sign * dx;
      let cy = y + sign * dy;
      while (inBoard(cx, cy) && board[cy][cx] === color) {
        cells.push({ x: cx, y: cy });
        cx += sign * dx;
        cy += sign * dy;
      }
    }
    if (cells.length >= WIN_LEN) return cells;
  }
  return null;
}

export function isBoardFull(board: Board): boolean {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!board[y][x]) return false;
    }
  }
  return true;
}

function makeNotation(x: number, y: number, color: string): string {
  const col = COL_LETTERS[x] ?? String(x + 1);
  return `${colorName(color)} ${col}${y + 1}`;
}

function lastMoveView(x: number, y: number): LastMove {
  return {
    x,
    y,
    from: { x, y },
    to: { x, y },
  };
}

/**
 * 落子
 * @returns {ok, error?, gameOver?, winnerId?, isDraw?, reason?, nextTurn?}
 */
export function applyMove(state: GameState, playerId: string, move: unknown): ApplyMoveResult {
  if (state.over) return { ok: false, error: '对局已结束' };
  const current = state.players[state.turn];
  if (!current || current.id !== playerId) return { ok: false, error: '还没轮到你' };

  const parsed = parseMove(move);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  const { x, y } = parsed;
  if (state.board[y][x]) return { ok: false, error: '该位置已有棋子' };

  const color = colorOfTurn(state.turn);
  state.board[y][x] = color;
  const notation = makeNotation(x, y, color);
  state.lastMove = lastMoveView(x, y);
  state.moves.push({
    player: current.id,
    x,
    y,
    from: { x, y },
    to: { x, y },
    captured: null,
    notation,
  });

  const winLine = findWinLine(state.board, x, y);
  if (winLine) {
    state.over = true;
    state.winnerId = current.id;
    state.isDraw = false;
    state.winLine = winLine;
    state.reason = `${colorName(color)}方五子连珠`;
    return {
      ok: true,
      gameOver: true,
      winnerId: current.id,
      isDraw: false,
      reason: state.reason,
    };
  }

  if (isBoardFull(state.board)) {
    state.over = true;
    state.winnerId = null;
    state.isDraw = true;
    state.reason = '棋盘已满，和棋';
    return { ok: true, gameOver: true, winnerId: null, isDraw: true, reason: state.reason };
  }

  const nextTurn = (state.turn + 1) % state.players.length;
  state.turn = nextTurn;
  state.turnStartedAt = Date.now();
  return { ok: true, nextTurn };
}

/**
 * 悔棋：撤销最后一步
 */
export function undoLastMove(state: GameState): UndoResult {
  if (state.over) return { ok: false, error: '对局已结束，无法悔棋' };
  if (state.moves.length === 0) return { ok: false, error: '没有可撤销的棋步' };

  const last = state.moves.pop()!;
  const x = last.x ?? last.to?.x;
  const y = last.y ?? last.to?.y;
  if (x == null || y == null) return { ok: false, error: '棋步数据不完整' };
  state.board[y][x] = null;
  state.winLine = null;

  state.turn = (state.turn + state.players.length - 1) % state.players.length;
  const prev = state.moves[state.moves.length - 1];
  state.lastMove = prev
    ? lastMoveView(prev.x ?? prev.to?.x ?? 0, prev.y ?? prev.to?.y ?? 0)
    : null;
  state.over = false;
  state.winnerId = null;
  state.isDraw = false;
  state.reason = null;
  state.turnStartedAt = Date.now();

  return { ok: true, turn: state.turn, notation: last.notation };
}

/** 认输 */
export function surrender(state: GameState, playerId: string): ApplyMoveResult {
  if (state.over) return { ok: false, error: '对局已结束' };
  const idx = state.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return { ok: false, error: '你不是本局玩家' };
  const winner = state.players[(idx + 1) % state.players.length];
  state.over = true;
  state.winnerId = winner.id;
  state.reason = `${state.players[idx].name} 认输`;
  return { ok: true, gameOver: true, winnerId: winner.id, isDraw: false, reason: state.reason };
}

/** 协商和棋 */
export function agreeDraw(state: GameState, reason = '双方协商和棋'): ApplyMoveResult {
  if (state.over) return { ok: false, error: '对局已结束' };
  state.over = true;
  state.isDraw = true;
  state.winnerId = null;
  state.reason = reason;
  return { ok: true, gameOver: true, winnerId: null, isDraw: true, reason: state.reason };
}

export function serialize(state: GameState): GameSnapshot {
  return {
    type,
    cols: COLS,
    rows: ROWS,
    board: state.board.map((row) => row.slice()),
    turn: state.turn,
    players: state.players.map((p) => ({ ...p })),
    moveCount: state.moves.length,
    moves: state.moves.map((m) => ({
      player: m.player,
      x: m.x ?? 0,
      y: m.y ?? 0,
      from: { x: m.x ?? 0, y: m.y ?? 0 },
      to: { x: m.x ?? 0, y: m.y ?? 0 },
      captured: null,
      notation: m.notation,
    })),
    timeLimit: state.timeLimit,
    gameTime: state.gameTime ?? 0,
    clocks: state.clocks ? { ...state.clocks } : null,
    turnStartedAt: state.turnStartedAt,
    lastMove: state.lastMove
      ? lastMoveView(state.lastMove.x ?? state.lastMove.from?.x ?? 0, state.lastMove.y ?? state.lastMove.from?.y ?? 0)
      : null,
    winLine: state.winLine ? state.winLine.map((c) => ({ ...c })) : null,
    check: null,
    captured: [],
    over: state.over,
    winnerId: state.winnerId,
    isDraw: state.isDraw,
    reason: state.reason,
  };
}
