/**
 * 五子棋规则单元测试
 * 运行：npx tsx test/gomoku.test.ts
 *
 * 坐标约定：board[y][x]，x∈[0,14] 列，y∈[0,14] 行；黑先白后
 */
import {
  initialBoard, create, applyMove, surrender, undoLastMove, serialize, parseMove,
  findWinLine, isBoardFull, inBoard, colorOfTurn, COLS, ROWS,
} from '../src/games/gomoku.js';
import { bestMove, evaluatePoint, candidateMoves } from '../src/games/gomoku-ai.js';

let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

const A = { id: 'u1', name: '甲' };
const B = { id: 'u2', name: '乙' };

function game() {
  return create([A, B], { timeLimit: 60 });
}

function play(state, player, x, y) {
  return applyMove(state, player, { x, y });
}

console.log('[1] 初始局面');
{
  const b = initialBoard();
  ok('棋盘 15x15', b.length === ROWS && b[0].length === COLS && COLS === 15);
  ok('全空', b.flat().every((c) => c == null));
  ok('天元在盘内', inBoard(7, 7) && !inBoard(15, 0) && !inBoard(-1, 0));
  const s = game();
  ok('黑方先手', s.turn === 0 && colorOfTurn(0) === 'b');
  ok('未结束', s.over === false);
}

console.log('[2] 走子校验');
{
  const s = game();
  ok('非法对象', applyMove(s, 'u1', null).ok === false);
  ok('缺坐标', applyMove(s, 'u1', {}).error);
  ok('越界', applyMove(s, 'u1', { x: 15, y: 0 }).ok === false);
  ok('非整数', applyMove(s, 'u1', { x: 1.5, y: 0 }).ok === false);
  ok('还没轮到白', applyMove(s, 'u2', { x: 7, y: 7 }).error === '还没轮到你');
  ok('黑落天元', play(s, 'u1', 7, 7).ok === true);
  ok('棋盘有黑子', s.board[7][7] === 'b');
  ok('轮到白', s.turn === 1);
  ok('重复落子被拒', play(s, 'u2', 7, 7).ok === false);
  ok('白可落旁边', play(s, 'u2', 8, 7).ok === true);
  ok('兼容 to 格式', applyMove(s, 'u1', { to: { x: 6, y: 7 } }).ok === true);
  ok('parseMove 规范化', parseMove({ x: 0, y: 0 }).x === 0 && !parseMove({ x: 0, y: 0 }).error);
}

console.log('[3] 横向五连获胜');
{
  const s = game();
  // 黑 (0,7)(1,7)(2,7)(3,7)(4,7)；白在别处
  const seq = [
    [A.id, 0, 7], [B.id, 0, 0],
    [A.id, 1, 7], [B.id, 1, 0],
    [A.id, 2, 7], [B.id, 2, 0],
    [A.id, 3, 7], [B.id, 3, 0],
    [A.id, 4, 7],
  ];
  let last;
  for (const [pid, x, y] of seq) last = play(s, pid, x, y);
  ok('黑方五连获胜', last.ok && last.gameOver && last.winnerId === A.id, JSON.stringify(last));
  ok('原因含五子连珠', last.reason?.includes('五子连珠'));
  ok('winLine 长度 ≥5', findWinLine(s.board, 4, 7)?.length >= 5);
  ok('结束后不能再下', play(s, B.id, 10, 10).ok === false);
}

console.log('[4] 纵向 / 斜向五连');
{
  const s = game();
  const seq = [
    [A.id, 7, 0], [B.id, 0, 0],
    [A.id, 7, 1], [B.id, 1, 0],
    [A.id, 7, 2], [B.id, 2, 0],
    [A.id, 7, 3], [B.id, 3, 0],
    [A.id, 7, 4],
  ];
  let last;
  for (const [pid, x, y] of seq) last = play(s, pid, x, y);
  ok('黑方纵向五连', last.gameOver && last.winnerId === A.id);

  const d = game();
  const diag = [
    [A.id, 2, 2], [B.id, 0, 14],
    [A.id, 3, 3], [B.id, 1, 14],
    [A.id, 4, 4], [B.id, 2, 14],
    [A.id, 5, 5], [B.id, 3, 14],
    [A.id, 6, 6],
  ];
  for (const [pid, x, y] of diag) last = play(d, pid, x, y);
  ok('黑方主对角线五连', last.gameOver && last.winnerId === A.id);

  const a = game();
  const anti = [
    [A.id, 10, 2], [B.id, 0, 0],
    [A.id, 9, 3], [B.id, 1, 0],
    [A.id, 8, 4], [B.id, 2, 0],
    [A.id, 7, 5], [B.id, 3, 0],
    [A.id, 6, 6],
  ];
  for (const [pid, x, y] of anti) last = play(a, pid, x, y);
  ok('黑方反对角线五连', last.gameOver && last.winnerId === A.id);
}

console.log('[5] 长连也算胜 / 白方获胜');
{
  const s = game();
  // 白在第 5 手连五（黑先下 5 手、白下 5 手，白的第五手获胜）
  // 黑占上行，白占下行
  const seq = [
    [A.id, 0, 0], [B.id, 0, 7],
    [A.id, 1, 0], [B.id, 1, 7],
    [A.id, 2, 0], [B.id, 2, 7],
    [A.id, 3, 0], [B.id, 3, 7],
    [A.id, 5, 0], [B.id, 4, 7], // 黑故意断开，白第五手连五
  ];
  let last;
  for (const [pid, x, y] of seq) last = play(s, pid, x, y);
  ok('白方五连获胜', last.gameOver && last.winnerId === B.id, last.reason);

  ok('五连检测阈值为 5', findWinLine((() => {
    const b = initialBoard();
    for (let x = 0; x < 6; x++) b[8][x] = 'b';
    return b;
  })(), 0, 8)?.length === 6);
}

console.log('[6] 悔棋 / 认输 / 序列化');
{
  const s = game();
  play(s, 'u1', 7, 7);
  play(s, 'u2', 8, 8);
  ok('两步后轮到黑', s.turn === 0 && s.moves.length === 2);
  const u = undoLastMove(s);
  ok('悔棋成功', u.ok === true);
  ok('白子被撤', s.board[8][8] == null && s.board[7][7] === 'b');
  ok('轮到白', s.turn === 1 && s.moves.length === 1);
  ok('空棋谱不能悔', undoLastMove(game()).ok === false);

  const t = game();
  const r = surrender(t, 'u1');
  ok('黑认输白胜', r.ok && r.winnerId === 'u2' && r.reason.includes('认输'));
  ok('结束后不能认输', surrender(t, 'u2').ok === false);

  const snap = serialize(game());
  ok('序列化含尺寸与空盘', snap.cols === 15 && snap.board[0].length === 15 && snap.type === 'gomoku');
}

console.log('[7] 棋盘已满判和');
{
  const full = initialBoard();
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      full[y][x] = (x + y) % 2 === 0 ? 'b' : 'w';
    }
  }
  ok('满盘检测', isBoardFull(full) === true);
  ok('空盘非满', isBoardFull(initialBoard()) === false);

  // 构造只剩一格的局面，最后一手不连五 → 和棋
  const g = game();
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (x === 14 && y === 14) continue;
      // 避免五连：按 2x2 块黑白交错，每行 bbwwbbww...
      const pair = Math.floor(x / 2);
      g.board[y][x] = (pair + y) % 2 === 0 ? 'b' : 'w';
    }
  }
  g.turn = 0;
  const last = play(g, 'u1', 14, 14);
  ok('最后一格可下', last.ok === true, last.error);
  ok('满盘和棋', last.gameOver === true && last.isDraw === true, JSON.stringify({ over: last.gameOver, draw: last.isDraw, reason: last.reason }));
}

console.log('[8] AI 启发式');
{
  const b = initialBoard();
  const first = bestMove(b, 'b');
  ok('空盘下天元', first && first.x === 7 && first.y === 7);

  const four = initialBoard();
  for (let x = 0; x < 4; x++) four[7][x] = 'b';
  four[0][0] = 'w';
  const win = bestMove(four, 'b');
  ok('黑冲四必成五', win && win.y === 7 && win.x === 4, JSON.stringify(win));

  const threat = initialBoard();
  for (let x = 0; x < 4; x++) threat[5][x] = 'w';
  threat[10][10] = 'b';
  const block = bestMove(threat, 'b');
  ok('必须挡住白冲四', block && block.y === 5 && block.x === 4, JSON.stringify(block));

  ok('候选点非空', candidateMoves(four).length > 0);
  ok('已占点评分为 -1', evaluatePoint(four, 0, 7, 'b') === -1);
}

console.log(`\n五子棋测试：通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
