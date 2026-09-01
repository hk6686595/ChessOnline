/**
 * 私聊端到端测试（真实 WebSocket）
 * 运行：npx tsx test/e2e-private.ts
 */
import WebSocket from 'ws';

const URL = 'ws://localhost:8080/ws';
let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name} ${extra}`); }
}
function open() {
  return new Promise((res, rej) => { const ws = new WebSocket(URL); ws.on('open', () => res(ws)); ws.on('error', rej); });
}
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

  const bp = waitMsg(b, 's.friend.request');
  send(a, { type: 'friend.add', name: B.name });
  await bp;
  const al = waitMsg(a, 's.friend.list');
  send(b, { type: 'friend.accept', friendId: A.id });
  await al;

  // A 给 B 发私聊
  const priv = waitMsg(b, 's.chat.private');
  send(a, { type: 'chat.private', toId: B.id, text: '你好，好友！' });
  const msg = await priv;
  ok('B 收到私聊', msg.fromId === A.id && msg.toId === B.id && msg.text === '你好，好友！', JSON.stringify(msg));

  // 非好友私聊应被拒（用新游客 C 试）
  const c = await open(); send(c, { type: 'auth.guest' });
  const C = (await waitMsg(c, 's.auth.ok')).user;
  const err = waitMsg(c, 's.error');
  send(c, { type: 'chat.private', toId: A.id, text: '陌生人' });
  const e = await err;
  ok('非好友私聊被拒绝', e.code === 'NOT_FRIENDS', JSON.stringify(e));

  console.log(failures === 0 ? '\n私聊 E2E 通过 ✅' : `\n私聊 E2E 失败 ❌ (${failures})`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
