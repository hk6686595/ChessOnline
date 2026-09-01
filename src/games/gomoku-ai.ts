/**
 * 五子棋 AI：启发式评分选点（进攻 + 防守）
 *
 * 空棋盘下天元；之后只评估已有棋子周围 2 格内的空点。
 * 连五必下、对手连五必挡，其余按活四/冲四/活三等权重打分。
 */
import { COLS, ROWS, inBoard } from './gomoku.js';
import type { Coord } from '../types.js';

type Board = (string | null)[][];
type Color = 'b' | 'w';

const DIRS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1,-1],
];

const SCORE = {
  five: 1_000_000,
  live4: 100_000,
  rush4: 10_000,
  live3: 8_000,
  sleep3: 700,
  live2: 500,
  sleep2: 40,
  live1: 10,
};

function opponent(color: Color): Color {
  return color === 'b' ? 'w' : 'b';
}

/** 该方向上，以 (x,y) 为中心（假设已落 color）的连续数与开口数 */
function dirPattern(board: Board, x: number, y: number, dx: number, dy: number, color: string): { count: number; open: number } {
  let count = 1;
  let open = 0;
  for (const sign of [1, -1]) {
    let cx = x + sign * dx;
    let cy = y + sign * dy;
    while (inBoard(cx, cy) && board[cy][cx] === color) {
      count++;
      cx += sign * dx;
      cy += sign * dy;
    }
    if (inBoard(cx, cy) && board[cy][cx] == null) open++;
  }
  return { count, open };
}

function patternScore(count: number, open: number): number {
  if (count >= 5) return SCORE.five;
  if (count === 4 && open === 2) return SCORE.live4;
  if (count === 4 && open === 1) return SCORE.rush4;
  if (count === 3 && open === 2) return SCORE.live3;
  if (count === 3 && open === 1) return SCORE.sleep3;
  if (count === 2 && open === 2) return SCORE.live2;
  if (count === 2 && open === 1) return SCORE.sleep2;
  if (count === 1 && open === 2) return SCORE.live1;
  return 0;
}

/** 假设在 (x,y) 落 color，该点进攻分 */
export function evaluatePoint(board: Board, x: number, y: number, color: string): number {
  if (!inBoard(x, y) || board[y][x]) return -1;
  let score = 0;
  for (const [dx, dy] of DIRS) {
    const { count, open } = dirPattern(board, x, y, dx, dy, color);
    score += patternScore(count, open);
  }
  return score;
}

function hasAnyStone(board: Board): boolean {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (board[y][x]) return true;
    }
  }
  return false;
}

/** 已有棋子周围 2 格内的空点（含中心） */
export function candidateMoves(board: Board): Coord[] {
  if (!hasAnyStone(board)) return [{ x: 7, y: 7 }];
  const seen = new Set();
  const out = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!board[y][x]) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!inBoard(nx, ny) || board[ny][nx]) continue;
          const key = ny * COLS + nx;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ x: nx, y: ny });
        }
      }
    }
  }
  return out;
}

/**
 * 选择最佳落点
 * @param {string[][]} board
 * @param {'b'|'w'} color
 * @returns {{x:number,y:number}|null}
 */
export function bestMove(board: Board, color: Color): Coord | null {
  const opp = opponent(color);
  const cands = candidateMoves(board);
  if (cands.length === 0) return null;

  // 能立刻五连则直接下
  for (const c of cands) {
    if (evaluatePoint(board, c.x, c.y, color) >= SCORE.five) return c;
  }
  // 对手能立刻五连则必须挡
  for (const c of cands) {
    if (evaluatePoint(board, c.x, c.y, opp) >= SCORE.five) return c;
  }

  let best = cands[0];
  let bestScore = -Infinity;
  for (const c of cands) {
    const attack = evaluatePoint(board, c.x, c.y, color);
    const defend = evaluatePoint(board, c.x, c.y, opp);
    // 略偏防守，避免漏挡冲四/活三
    const s = attack + defend * 1.15;
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}
