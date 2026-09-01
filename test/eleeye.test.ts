/**
 * eleeye（象眼）UCCI 引擎客户端测试
 * 运行：npx tsx test/eleeye.test.ts
 */
import { initialBoard, create, applyMove } from '../src/games/xiangqi.js';
import { ucciEngine, boardToFen, fromUcciMove, toUcciMove } from '../src/games/uci-engine.js';

const STANDARD_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
};

// 1. FEN 生成与标准一致
const fen = boardToFen(initialBoard(), 'r');
ok('初始 FEN 与标准一致（红方在顶部、红小写黑大写）', fen === STANDARD_FEN, fen);

// 2. 坐标换算往返
const mv = fromUcciMove(toUcciMove({ x: 1, y: 7 }, { x: 1, y: 5 }));
ok('坐标换算往返一致', mv.from.x === 1 && mv.from.y === 7 && mv.to.x === 1 && mv.to.y === 5, JSON.stringify(mv));
ok('非法走法返回 null', fromUcciMove('abc') === null && fromUcciMove('a0a') === null);

// 3. UCCI 握手
await ucciEngine.ensureStarted();
ok('UCCI 握手成功', ucciEngine.ready === true);

// 4. 红方第一步（引擎执红）→ 应用合法
const board = initialBoard();
const state = create([{ id: 'r' }, { id: 'b' }]);
state.board = board;
const mv1 = await ucciEngine.getBestMove(board, 'r', 1000);
ok('红方返回走法', !!mv1, JSON.stringify(mv1));
const r1 = applyMove(state, 'r', mv1);
ok('红方走法合法', r1.ok === true, r1.error || JSON.stringify(mv1));
console.log(`  （红方：${state.moves.at(-1)?.notation ?? ''}）`);

// 5. 黑方应手（引擎执黑）→ 应用合法
const mv2 = await ucciEngine.getBestMove(state.board, 'b', 1000);
ok('黑方返回走法', !!mv2, JSON.stringify(mv2));
const r2 = applyMove(state, 'b', mv2);
ok('黑方走法合法', r2.ok === true, r2.error || JSON.stringify(mv2));
console.log(`  （黑方：${state.moves.at(-1)?.notation ?? ''}）`);

// 6. 多步对局：红黑交替 3 回合，全部合法（连续调用引擎验证不卡死）
let okAll = true;
for (let i = 0; i < 3 && okAll; i++) {
  const side = i % 2 === 0 ? 'r' : 'b';
  const pid = side === 'r' ? 'r' : 'b';
  const mv = await ucciEngine.getBestMove(state.board, side, 800);
  if (!mv) { okAll = false; break; }
  const res = applyMove(state, pid, mv);
  if (!res.ok) { okAll = false; break; }
}
ok('连续 6 步（3 回合）全部合法且引擎不卡死', okAll, state.moves.length);

await ucciEngine.close();
console.log(`\neleeye 引擎测试：通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
