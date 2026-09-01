/**
 * 棋谱删除/收藏端到端测试（真实 WebSocket 连接运行中服务器）
 * 运行：npx tsx test/e2e-match-ops.ts
 *
 * 场景：
 *   A、B 对局两回合后 B 认输 → 产生对局记录
 *   非参与者 C 收藏/删除被拒
 *   A 收藏 → 列表 favorited=true；取消收藏 → false
 *   A 删除 → A 列表不再含该对局，且无法再查看棋谱详情
 *   B 列表不受影响（软删除仅对自己隐藏），B 可独立收藏
 */
import WebSocket from 'ws';

const URL = 'ws://localhost:8080/ws';
let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name} ${extra}`); }
}

function open() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function waitMsg(ws, type, timeout = 5000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting ' + type)), timeout);
    const h = (d) => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.type === type) { clearTimeout(t); ws.off('message', h); res(m); }
    };
    ws.on('message', h);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function guest() {
  const ws = await open();
  send(ws, { type: 'auth.guest' });
  const auth = await waitMsg(ws, 's.auth.ok');
  return { ws, user: auth.user };
}

async function main() {
  const a = await guest();
  const b = await guest();
  const c = await guest();
  console.log(`  A=${a.user.name}(${a.user.id})  B=${b.user.name}(${b.user.id})  C=${c.user.name}(${c.user.id})`);

  // ---- 产生一盘象棋对局（A 红先手，B 认输）----
  const aj = waitMsg(a.ws, 's.room.joined');
  send(a.ws, { type: 'room.create', gameType: 'xiangqi' });
  const room = await aj;
  const roomId = room.room.id;

  const bj = waitMsg(b.ws, 's.room.joined');
  send(b.ws, { type: 'room.join', roomId });
  await bj;

  send(a.ws, { type: 'room.ready', ready: true });
  send(b.ws, { type: 'room.ready', ready: true });
  await sleep(200);
  send(a.ws, { type: 'room.start' });
  await waitMsg(a.ws, 's.game.start');

  const mv1 = waitMsg(b.ws, 's.game.move');
  send(a.ws, { type: 'game.move', move: { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } } }); // 红炮平中
  await mv1;
  const mv2 = waitMsg(a.ws, 's.game.move');
  send(b.ws, { type: 'game.move', move: { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } } }); // 黑马跳日
  await mv2;

  const over = waitMsg(a.ws, 's.game.over');
  send(b.ws, { type: 'game.surrender' });
  await over;
  console.log('  对局结束（B 认输，A 胜，2 手）');

  // ---- A 拉取战绩，找到该对局 ----
  const listP = waitMsg(a.ws, 's.matches');
  send(a.ws, { type: 'matches.get', userId: a.user.id, limit: 50 });
  const list = await listP;
  const rec = list.matches[0];
  ok('A 战绩含新对局（2 手）', !!rec && rec.moveCount === 2, JSON.stringify(list.matches?.[0]));
  ok('新对局默认未收藏', rec && rec.favorited === false, `favorited=${rec?.favorited}`);
  const matchId = rec.id;

  // ---- 非参与者 C 操作被拒 ----
  const errP1 = waitMsg(c.ws, 's.error');
  send(c.ws, { type: 'match.favorite', matchId, favorite: true });
  const err1 = await errP1;
  ok('非参与者收藏被拒', err1.code === 'BAD_REQUEST', err1.code);

  const errP2 = waitMsg(c.ws, 's.error');
  send(c.ws, { type: 'match.delete', matchId });
  const err2 = await errP2;
  ok('非参与者删除被拒', err2.code === 'BAD_REQUEST', err2.code);

  // ---- A 收藏 → 回推列表 favorited=true ----
  const favP = waitMsg(a.ws, 's.matches');
  send(a.ws, { type: 'match.favorite', matchId, favorite: true });
  const favList = await favP;
  const favRec = favList.matches.find((m) => m.id === matchId);
  ok('收藏后 favorited=true', favRec?.favorited === true, JSON.stringify(favRec?.favorited));

  // ---- A 取消收藏 → favorited=false ----
  const unfavP = waitMsg(a.ws, 's.matches');
  send(a.ws, { type: 'match.favorite', matchId, favorite: false });
  const unfavList = await unfavP;
  ok('取消收藏后 favorited=false', unfavList.matches.find((m) => m.id === matchId)?.favorited === false);

  // ---- B 收藏（与 A 互不影响）----
  const bFavP = waitMsg(b.ws, 's.matches');
  send(b.ws, { type: 'match.favorite', matchId, favorite: true });
  const bFavList = await bFavP;
  ok('B 独立收藏成功', bFavList.matches.find((m) => m.id === matchId)?.favorited === true);

  // ---- A 删除 → A 列表消失 / 详情不可见；B 列表仍在 ----
  const delP = waitMsg(a.ws, 's.matches');
  send(a.ws, { type: 'match.delete', matchId });
  const delList = await delP;
  ok('A 删除后列表不含该对局', !delList.matches.some((m) => m.id === matchId),
    `count=${delList.matches.length}`);

  const detErrP = waitMsg(a.ws, 's.error');
  send(a.ws, { type: 'match.detail.get', matchId });
  const detErr = await detErrP;
  ok('A 无法再查看已删棋谱', detErr.code === 'NOT_FOUND', detErr.code);

  const bListP = waitMsg(b.ws, 's.matches');
  send(b.ws, { type: 'matches.get', userId: b.user.id, limit: 50 });
  const bList = await bListP;
  const bRec = bList.matches.find((m) => m.id === matchId);
  ok('B 列表仍含该对局（软删除不影响对手）', !!bRec);
  ok('B 的收藏标记保留', bRec?.favorited === true, `favorited=${bRec?.favorited}`);

  // B 仍可正常复盘该对局
  const bDetP = waitMsg(b.ws, 's.match.detail');
  send(b.ws, { type: 'match.detail.get', matchId });
  const bDet = await bDetP;
  ok('B 仍可查看棋谱详情', bDet.match?.id === matchId && bDet.match?.moves?.length === 2);

  a.ws.close(); b.ws.close(); c.ws.close();
  console.log(failures === 0 ? '\nE2E 通过 ✅' : `\nE2E 失败 ❌ (${failures})`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
