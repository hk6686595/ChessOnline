/**
 * 中国象棋 AI 引擎单元测试
 * 运行：npx tsx test/xiangqi-ai.test.ts
 */
import { initialBoard, applyMove, genLegalMoves, isInCheck } from '../src/games/xiangqi.js';
import { bestMove, evaluate } from '../src/games/xiangqi-ai.js';

let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

console.log('[1] AI 返回合法走法（初始局面）');
{
  const b = initialBoard();
  const t0 = Date.now();
  const move = bestMove(b, 'b', 3); // 电脑执黑
  const ms = Date.now() - t0;
  ok('AI 返回走法', !!move, JSON.stringify(move));
  ok('走法合法', genLegalMoves(b, 'b').some((m) => m.from.x === move.from.x && m.from.y === move.from.y && m.to.x === move.to.x && m.to.y === move.to.y));
  ok(`AI 计算耗时 ${ms}ms < 2000ms`, ms < 2000, `${ms}ms`);
}

console.log('[2] AI 能吃将（一步可吃将时直接取胜）');
{
  const b = emptyBoard();
  b[9][3] = 'rk';  // 红帅 (3,9)
  b[0][4] = 'bk';  // 黑将 (4,0)
  b[5][4] = 'rr';  // 红车 (4,5) 与黑将同列
  // 轮到红方：红车 (4,5) → (4,0) 吃将
  const move = bestMove(b, 'r', 3);
  ok('AI 选择吃将', move && move.to.x === 4 && move.to.y === 0, JSON.stringify(move));
}

console.log('[3] AI 不走出送将的棋（被将军时选择应将）');
{
  const b = emptyBoard();
  b[9][4] = 'rk';  // 红帅 (4,9)
  b[0][4] = 'bk';  // 黑将 (4,0) —— 同列无遮挡 → 红方被照面将军
  ok('红方处于被将军（照面）', isInCheck(b, 'r') === true);
  // 红方唯一解：帅横移避开照面（(3,9) 或 (5,9)）
  const move = bestMove(b, 'r', 3);
  ok('AI 选择应将（帅横移）', !!move && move.from.y === 9 && move.from.x === 4 && Math.abs(move.to.x - 4) === 1, JSON.stringify(move));
}

console.log('[4] 评估函数对称性');
{
  const b = initialBoard();
  ok('初始局面评估为 0', evaluate(b) === 0, `score=${evaluate(b)}`);
  // 红多一车 → 正分
  const b2 = emptyBoard();
  b2[9][0] = 'rr';
  b2[0][0] = 'bk';
  b2[9][4] = 'rk';
  ok('红方优势为正分', evaluate(b2) > 0, `score=${evaluate(b2)}`);
}

console.log('[5] AI 对局：红方走 6 步（与 AI 交替）');
{
  const state = { board: initialBoard() };
  // 简化：直接用 applyMove 模拟，AI 每次执黑回应红方一步
  const b = initialBoard();
  const state2 = { board: b, turn: 0, players: [{ id: 'p' }, { id: 'ai' }], moves: [], captured: [], lastMove: null, check: null, timeLimit: 60, turnStartedAt: Date.now(), over: false };
  const redMoves = [
    { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } }, // 炮八进二
    { from: { x: 7, y: 9 }, to: { x: 6, y: 7 } }, // 马二进三
    { from: { x: 0, y: 9 }, to: { x: 0, y: 7 } }, // 车一进三
  ];
  let aiMoves = 0;
  for (const rm of redMoves) {
    const r1 = applyMove(state2, 'p', rm);
    ok(`红方第 ${redMoves.indexOf(rm) + 1} 步合法`, r1.ok === true, JSON.stringify(r1));
    if (!r1.ok) break;
    if (r1.gameOver) break;
    const aiMove = bestMove(state2.board, 'b', 3);
    ok('AI 有回应走法', !!aiMove);
    const r2 = applyMove(state2, 'ai', aiMove);
    ok('AI 走法合法', r2.ok === true, JSON.stringify(r2));
    if (r2.ok) aiMoves++;
    if (r2.gameOver) break;
  }
  ok(`AI 共回应 ${aiMoves} 步`, aiMoves >= 3, `aiMoves=${aiMoves}`);
}

console.log(`\nAI 引擎测试：通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
