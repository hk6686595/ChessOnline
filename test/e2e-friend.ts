/**
 * 好友/邀请端到端测试（真实 WebSocket 连接运行中服务器）
 * 运行：npx tsx test/e2e-friend.ts
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
function waitMsg(ws, type, timeout = 4000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting ' + type)), timeout);
    const h = (d) => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.type === type) { clearTimeout(t); ws.off('message', h); res(m); }
    };
    ws.on('message', h);
  });
}

async function main() {
  const a = await open();
  send(a, { type: 'auth.guest' });
  const aAuth = await waitMsg(a, 's.auth.ok');
  const A = aAuth.user;

  const b = await open();
  send(b, { type: 'auth.guest' });
  const bAuth = await waitMsg(b, 's.auth.ok');
  const B = bAuth.user;

  console.log(`  A=${A.name}(${A.id})  B=${B.name}(${B.id})`);

  // 1. A 加 B 为好友
  const bp = waitMsg(b, 's.friend.request');
  send(a, { type: 'friend.add', name: B.name });
  const req = await bp;
  ok('B 收到好友请求', req.id === A.id && req.name === A.name, JSON.stringify(req));

  // 2. B 接受
  const al = waitMsg(a, 's.friend.list');
  send(b, { type: 'friend.accept', friendId: A.id });
  const alist = await al;
  ok('A 列表含 B 为好友', alist.friends.some((f) => f.id === B.id), JSON.stringify(alist.friends));

  // 3. A 创建 pvp 房间
  const aj = waitMsg(a, 's.room.joined');
  send(a, { type: 'room.create', gameType: 'xiangqi' });
  const room = await aj;
  const roomId = room.room.id;
  ok('A 创建 pvp 房间', !!roomId, JSON.stringify(room.room && room.room.mode));

  // 4. A 邀请 B
  const bi = waitMsg(b, 's.invite');
  send(a, { type: 'invite.send', friendId: B.id, roomId });
  const inv = await bi;
  ok('B 收到邀请且房间一致', inv.roomId === roomId && inv.fromId === A.id, JSON.stringify(inv));

  // 5. B 接受邀请加入房间
  const bj = waitMsg(b, 's.room.joined');
  send(b, { type: 'room.join', roomId });
  const bjoin = await bj;
  ok('B 成功加入房间', bjoin.room && bjoin.room.id === roomId);

  console.log(failures === 0 ? '\nE2E 通过 ✅' : `\nE2E 失败 ❌ (${failures})`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
