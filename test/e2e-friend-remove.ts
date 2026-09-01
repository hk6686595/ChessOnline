/**
 * 删除好友后对方是否同步（端到端）
 * 运行：npx tsx test/e2e-friend-remove.ts
 */
import WebSocket from 'ws';

const URL = 'ws://localhost:8080/ws';
let failures = 0;
function ok(name, cond, extra = '') { if (cond) console.log(`  ✅ ${name}`); else { failures++; console.log(`  ❌ ${name} ${extra}`); } }
function open() { return new Promise((res, rej) => { const ws = new WebSocket(URL); ws.on('open', () => res(ws)); ws.on('error', rej); }); }
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function waitMsg(ws, type, timeout = 4000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + type)), timeout);
    const h = (d) => { let m; try { m = JSON.parse(d); } catch { return; } if (m.type === type) { clearTimeout(t); ws.off('message', h); res(m); } };
    ws.on('message', h);
  });
}

async function main() {
  const a = await open(); send(a, { type: 'auth.guest' });
  const A = (await waitMsg(a, 's.auth.ok')).user;
  const b = await open(); send(b, { type: 'auth.guest' });
  const B = (await waitMsg(b, 's.auth.ok')).user;

  // A 加 B，B 接受
  const bp = waitMsg(b, 's.friend.request');
  send(a, { type: 'friend.add', name: B.name });
  await bp;
  const al = waitMsg(a, 's.friend.list');
  send(b, { type: 'friend.accept', friendId: A.id });
  const alist = await al;
  ok('接受前 B 列表含 A', alist.friends.some((f) => f.id === A.id));

  // A 删除 B
  const bListAfterRemove = waitMsg(b, 's.friend.list');
  send(a, { type: 'friend.remove', friendId: B.id });
  const rem = await bListAfterRemove;
  ok('删除后 B 列表不含 A', !rem.friends.some((f) => f.id === A.id), JSON.stringify(rem.friends.map((f) => f.id)));

  // 反向：B 删 A 后 A 也应同步
  const aList = waitMsg(a, 's.friend.list');
  send(b, { type: 'friend.remove', friendId: A.id });
  const arem = await aList;
  ok('反向删除后 A 列表不含 B', !arem.friends.some((f) => f.id === B.id), JSON.stringify(arem.friends.map((f) => f.id)));

  console.log(failures === 0 ? '\n删除同步 E2E 通过 ✅' : `\n删除同步 E2E 失败 ❌ (${failures})`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
