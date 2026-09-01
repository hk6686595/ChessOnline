/**
 * 中国象棋 AI 引擎（服务端权威走棋）
 *
 * 算法：极小化极大（minimax）+ α-β 剪枝 + 走法排序 + 静态评估。
 * - 评估：棋子价值 + 过河兵加成，从红方视角计分（红正黑负）
 * - AI 执黑时选择使评估值最小的走法，执红时选最大
 * - 走法排序：吃子优先、将军优先，提升剪枝效率
 */
import {
  genLegalMoves, makeMove, isInCheck,
} from './xiangqi.js';
import type { Coord, Move } from '../types.js';

type Board = (string | null)[][];
type Color = 'r' | 'b';

// 棋子价值（黑方棋子按负值计）
const VALUES = {
  k: 10000, // 将/帅
  r: 900,   // 车
  c: 450,   // 炮
  h: 400,   // 马
  e: 200,   // 象/相
  a: 200,   // 士/仕
  p: 100,   // 兵/卒
};

const MATE = 100000;
const INF = 1e9;

/**
 * 静态评估（红方视角）
 */
export function evaluate(board: Board): number {
  let score = 0;
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board[y].length; x++) {
      const code = board[y][x];
      if (!code) continue;
      const red = code[0] === 'r';
      const sign = red ? 1 : -1;
      const base = (VALUES as Record<string, number>)[code[1]] ?? 0;
      let value = base;
      // 过河兵加分（红兵过河 y<=4，黑卒过河 y>=5）
      if (code[1] === 'p') {
        if (red && y <= 4) value += 40;
        if (!red && y >= 5) value += 40;
      }
      score += sign * value;
    }
  }
  return score;
}

/** 走法排序分数：吃子价值 + 将军奖励（值越大越优先搜索） */
function moveScore(board: Board, from: Coord, to: Coord, color: string): number {
  let s = 0;
  const target = board[to.y][to.x];
  if (target) s += 10 + ((VALUES as Record<string, number>)[target[1]] ?? 0);
  const nb = makeMove(board, from, to);
  if (isInCheck(nb, color === 'r' ? 'b' : 'r')) s += 50; // 将军
  return s;
}

/**
 * minimax + α-β 剪枝
 * @param board 当前棋盘
 * @param depth 剩余深度
 * @param alpha beta 剪枝边界
 * @param color 当前走棋方 'r' | 'b'
 * @returns 红方视角的评估分数
 */
function minimax(board: Board, depth: number, alpha: number, beta: number, color: Color): number {
  const moves = genLegalMoves(board, color);
  if (moves.length === 0) {
    // 将死或困毙：当前方输（红方视角）
    return color === 'r' ? -MATE + depth : MATE - depth;
  }
  if (depth <= 0) return evaluate(board);

  if (color === 'r') {
    // 红方最大化
    let best = -INF;
    for (const m of moves) {
      const nb = makeMove(board, m.from, m.to);
      const score = minimax(nb, depth - 1, alpha, beta, 'b');
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (beta <= alpha) break;
    }
    return best;
  }
  // 黑方最小化
  let best = INF;
  for (const m of moves) {
    const nb = makeMove(board, m.from, m.to);
    const score = minimax(nb, depth - 1, alpha, beta, 'r');
    if (score < best) best = score;
    if (best < beta) beta = best;
    if (beta <= alpha) break;
  }
  return best;
}

/**
 * 从候选走法中挑选与最优评分接近的前 k 个（用于弱档随机抖动）
 * @param {{m:object,score:number}[]} candidates 末层所有走法评分
 * @param {'r'|'b'} color 走棋方
 * @param {number} k 取前 k 个
 */
function pickTopCandidates(candidates: { m: Move; score: number }[], color: Color, k: number): Move[] {
  if (candidates.length <= 1) return candidates.map((c) => c.m);
  const bestScore = color === 'r'
    ? Math.max(...candidates.map((c) => c.score))
    : Math.min(...candidates.map((c) => c.score));
  // 与最优评分相差不大即视为"等价好棋"，制造弱档的随机性
  const tied = candidates.filter((c) => Math.abs(c.score - bestScore) < 30);
  tied.sort((a, b) => (color === 'r' ? b.score - a.score : a.score - b.score));
  return tied.slice(0, Math.max(1, k)).map((c) => c.m);
}

/**
 * 计算最佳走法
 * @param board 棋盘
 * @param color AI 执方 'r' | 'b'
 * @param maxDepth 搜索深度（默认 3）
 * @param opts { randomTopK } 末层从等价最优走法里随机选 1 个（>1 时生效，用于弱档）
 * @returns { from: {x,y}, to: {x,y} } | null（无合法走法）
 */
export function bestMove(board: Board, color: Color, maxDepth = 3, opts: { randomTopK?: number } = {}): Move | null {
  const randomTopK = opts.randomTopK ?? 1;
  const moves = genLegalMoves(board, color);
  if (moves.length === 0) return null;

  // 按吃子/将军价值排序，优先搜索高价值走法
  moves.sort((a, b) => moveScore(board, b.from, b.to, color) - moveScore(board, a.from, a.to, color));

  // 迭代加深：先浅后深，保证在时限内总能返回一个走法
  let best = moves[0];
  let bestScore = color === 'r' ? -INF : INF;
  for (let depth = 1; depth <= maxDepth; depth++) {
    let curBest: Move | null = null;
    let curScore = color === 'r' ? -INF : INF;
    let alpha = -INF;
    let beta = INF;
    let improved = false;
    const candidates: { m: Move; score: number }[] | null = depth === maxDepth ? [] : null;
    for (const m of moves) {
      const nb = makeMove(board, m.from, m.to);
      const score = minimax(nb, depth - 1, alpha, beta, color === 'r' ? 'b' : 'r');
      if (color === 'r') {
        if (score > curScore) { curScore = score; curBest = m; improved = true; }
        if (curScore > alpha) alpha = curScore;
      } else {
        if (score < curScore) { curScore = score; curBest = m; improved = true; }
        if (curScore < beta) beta = curScore;
      }
      if (candidates) candidates.push({ m, score });
    }
    if (curBest && improved) {
      best = curBest;
      bestScore = curScore;
    }
    // 已找到必胜/必败局面，无需加深
    if (Math.abs(bestScore) >= MATE - 100) break;
    // 末层：若开启随机，从等价最优走法里随机挑一个（弱档抖动）
    if (candidates && randomTopK > 1) {
      const pool = pickTopCandidates(candidates, color, randomTopK);
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }
  return best;
}
