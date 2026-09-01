/**
 * 端到端自测：模拟多个客户端走完 注册/建房/加入/就绪/开始/象棋对局/匹配/观战/认输/聊天/掉线/重连 等流程
 * 运行：npx tsx test/e2e.test.ts   （需先启动服务器）
 */
import WebSocket from 'ws';

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8080/ws';
const HTTP_URL = process.env.HTTP_URL || 'http://127.0.0.1:8080';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name} ${extra}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Client {
  constructor() {
    this.ws = new WebSocket(WS_URL);
    this.msgs = [];
    this.waiters = [];
    this.connected = new Promise((res, rej) => {
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
    this.ws.on('message', (d) => {
      let m;
      try { m = JSON.parse(d.toString()); } catch { return; }
      this.msgs.push(m);
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        const typeHit = w.anyTypes.includes(m.type);
        const predHit = !w.pred || w.pred(m);
        if (typeHit && predHit) {
          this.waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(m);
          break;
        }
      }
    });
  }

  send(type, payload = {}) {
    this.ws.send(JSON.stringify({ type, ...payload }));
  }

  /** 等待下一个指定类型事件（只匹配调用之后到达的消息），可带条件 */
  waitFor(type, { pred, timeout = 8000 } = {}) {
    return this.waitForAny([type], { pred, timeout });
  }

  /** 等待多种事件中的任意一种 */
  waitForAny(types, { pred, timeout = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      const w = {
        anyTypes: types,
        pred,
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          const recent = this.msgs.slice(-10).map((m) =>
            m.type === 's.game.move' ? `move(${m.move?.from?.x},${m.move?.from?.y}->${m.move?.to?.x},${m.move?.to?.y})` :
            m.type === 's.game.over' ? `over(w=${m.winnerId})` :
            m.type === 's.error' ? `err(${m.code})` : m.type
          );
          reject(new Error(`等待事件 ${types.join('/')} 超时，最近消息: ${recent.join(' | ')}`));
        }, timeout),
      };
      this.waiters.push(w);
    });
  }

  last(type) {
    return [...this.msgs].reverse().find((m) => m.type === type);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function auth(client, { name, password, register = true } = {}) {
  await client.connected;
  // 注册不再自动登录：先注册（等 s.auth.registered），再显式登录
  if (register) {
    const pReg = client.waitFor('s.auth.registered');
    client.send('auth.register', { name, password });
    const reg = await pReg;
    if (!reg || reg.name !== name) throw new Error(`注册确认异常: ${JSON.stringify(reg)}`);
    // 注册后应停留在未登录状态（无 s.auth.ok / s.me.state）
    await sleep(150);
  }
  // 服务端会在 auth.ok 后立刻推送 me.state，必须先注册监听再发送
  const pAuth = client.waitFor('s.auth.ok');
  const pState = client.waitFor('s.me.state');
  client.send('auth.login', { name, password });
  const [a] = await Promise.all([pAuth, pState]);
  return a.user;
}

function randName(prefix) {
  return `${prefix}${Math.floor(Math.random() * 100000)}`;
}

/** 等待指定 from→to 的走子广播 */
function waitMove(who, from, to) {
  return who.waitForAny(['s.game.move', 's.game.over'], {
    pred: (m) =>
      (m.type === 's.game.move' && m.move.from.x === from.x && m.move.from.y === from.y
        && m.move.to.x === to.x && m.move.to.y === to.y) ||
      (m.type === 's.game.over' && !!m.game),
  });
}

async function testXiangqiFullGame() {
  console.log('\n[1] 中国象棋完整对局：注册 → 建房 → 加入 → 就绪 → 开始 → 走子 → 认输结算');
  const a = new Client();
  const b = new Client();
  const userA = await auth(a, { name: randName('棋手A'), password: 'pass1234' });
  const userB = await auth(b, { name: randName('棋手B'), password: 'pass1234' });

  a.send('room.create', { gameType: 'xiangqi', name: '测试对局' });
  const joinedA = await a.waitFor('s.room.joined');
  const roomId = joinedA.room.id;
  ok('A 创建象棋房间成功', joinedA.room.gameType === 'xiangqi');

  b.send('room.join', { roomId });
  await b.waitFor('s.room.joined');
  ok('B 加入房间成功', b.last('s.room.joined').room.players.length === 2);

  a.send('room.ready', { ready: true });
  b.send('room.ready', { ready: true });
  await sleep(200);
  a.send('room.start');
  const startMsg = await a.waitFor('s.game.start');
  ok('双方收到对局开始', true);
  ok('初始棋盘 32 子', startMsg.game.board.flat().filter(Boolean).length === 32);
  ok('红方先手', startMsg.game.turn === 0);

  // 标准开局走几步
  const seq = [
    ['A', { x: 1, y: 7 }, { x: 1, y: 5 }],   // 红炮平一（前进）
    ['B', { x: 1, y: 0 }, { x: 2, y: 2 }],   // 黑马上
    ['A', { x: 7, y: 9 }, { x: 6, y: 7 }],   // 红马出
    ['B', { x: 7, y: 0 }, { x: 6, y: 2 }],   // 黑马出
    ['A', { x: 0, y: 9 }, { x: 0, y: 7 }],   // 红车进
    ['B', { x: 0, y: 0 }, { x: 0, y: 2 }],   // 黑车进
  ];
  for (let i = 0; i < seq.length; i++) {
    const [who, from, to] = seq[i];
    const sender = who === 'A' ? a : b;
    const viewer = who === 'A' ? b : a;
    sender.send('game.move', { move: { from, to } });
    const mv = await waitMove(viewer, from, to);
    ok(`第 ${i + 1} 手 ${who} ${from.x},${from.y}→${to.x},${to.y} 广播`, mv.type === 's.game.move');
  }
  ok('已走 6 手', a.last('s.game.move').game.moveCount === 6);

  // 非法走法：轮到他方时走子被拒；移动对方棋子被拒
  const bad1 = await (async () => {
    a.send('game.move', { move: { from: { x: 2, y: 9 }, to: { x: 0, y: 7 } } }); // 此时轮到 B
    const err = await a.waitFor('s.error');
    return err;
  })();
  ok('非回合方走子被拒绝', !!bad1 && (bad1.code === 'INVALID_MOVE' || bad1.code === 'NOT_YOUR_TURN'), bad1?.code);
  const bad2 = await (async () => {
    b.send('game.move', { move: { from: { x: 1, y: 9 }, to: { x: 2, y: 7 } } }); // B 移红马
    const err = await b.waitFor('s.error');
    return err;
  })();
  ok('移动对方棋子被拒绝', !!bad2 && bad2.code === 'INVALID_MOVE', bad2?.code);

  // B 认输 → A 胜
  b.send('game.surrender');
  const over = await a.waitFor('s.game.over');
  ok('认输后 A 获胜', over.winnerId === userA.id, `winner=${over.winnerId}`);
  ok('A 收到 GAME_OVER', !!a.last('s.game.over'));

  // 积分更新
  const ratingMsg = a.last('s.rating.update') || (await a.waitFor('s.rating.update'));
  const updatedA = ratingMsg.users.find((u) => u.id === userA.id);
  ok('获胜者积分提升', updatedA.rating > userA.rating, `${updatedA.rating} > ${userA.rating}`);
  ok('胜场 +1', updatedA.wins === userA.wins + 1);

  // 再来一局
  a.send('game.restart');
  await b.waitFor('s.game.restarted');
  ok('重开一局成功', true);

  a.close();
  b.close();
}

async function testGomokuFullGame() {
  console.log('\n[1b] 五子棋完整对局：建房 → 落子 → 五连获胜');
  const a = new Client();
  const b = new Client();
  const userA = await auth(a, { name: randName('五子A'), password: 'pass1234' });
  const userB = await auth(b, { name: randName('五子B'), password: 'pass1234' });

  a.send('room.create', { gameType: 'gomoku', name: '五子棋测试' });
  const joinedA = await a.waitFor('s.room.joined');
  ok('A 创建五子棋房间成功', joinedA.room.gameType === 'gomoku' && joinedA.room.gameName === '五子棋');

  b.send('room.join', { roomId: joinedA.room.id });
  await b.waitFor('s.room.joined');
  a.send('room.ready', { ready: true });
  b.send('room.ready', { ready: true });
  await sleep(200);
  a.send('room.start');
  const startMsg = await a.waitFor('s.game.start');
  ok('五子棋开局 15×15 空盘', startMsg.game.type === 'gomoku' && startMsg.game.cols === 15
    && startMsg.game.board.flat().filter(Boolean).length === 0);
  ok('黑方先手', startMsg.game.turn === 0);

  // 黑连五，白落在无关位置
  const seq = [
    [a, { x: 7, y: 7 }],
    [b, { x: 0, y: 0 }],
    [a, { x: 8, y: 7 }],
    [b, { x: 0, y: 1 }],
    [a, { x: 9, y: 7 }],
    [b, { x: 0, y: 2 }],
    [a, { x: 10, y: 7 }],
    [b, { x: 0, y: 3 }],
    [a, { x: 11, y: 7 }],
  ];
  let over = null;
  for (let i = 0; i < seq.length; i++) {
    const [who, pos] = seq[i];
    const obs = who === a ? b : a;
    // 先注册监听再落子，并按坐标匹配，避免抓到上一手仍在途的广播
    const p = obs.waitForAny(['s.game.move', 's.game.over'], {
      pred: (m) =>
        m.type === 's.game.over' ||
        (m.type === 's.game.move' && m.move?.from?.x === pos.x && m.move?.from?.y === pos.y),
    });
    who.send('game.move', { move: pos });
    const msg = await p;
    if (i < seq.length - 1) {
      ok(`第 ${i + 1} 手 ${pos.x},${pos.y} 广播`, msg.type === 's.game.move' && msg.game.board[pos.y][pos.x]);
    } else {
      over = msg.type === 's.game.over' ? msg : await a.waitFor('s.game.over');
    }
  }
  ok('黑方五连获胜', over && over.winnerId === userA.id && over.isDraw === false, JSON.stringify({ winner: over?.winnerId, reason: over?.reason }));
  ok('结束原因含五子连珠', over?.reason?.includes('五子连珠'));
  a.send('game.move', { move: { x: 5, y: 5 } });
  const err = await a.waitFor('s.error');
  ok('结束后落子被拒绝', err.code === 'INVALID_MOVE');

  a.close();
  b.close();
}

async function testMatchmaking() {
  console.log('\n[2] 匹配系统：两个玩家同时匹配 → 自动建房开局');
  const c = new Client();
  const d = new Client();
  await auth(c, { name: randName('匹手C'), password: 'pass1234' });
  await auth(d, { name: randName('匹手D'), password: 'pass1234' });

  c.send('match.enqueue', { gameType: 'xiangqi' });
  await c.waitFor('s.match.queued');
  d.send('match.enqueue', { gameType: 'xiangqi' });
  await d.waitFor('s.match.queued');

  const [foundC, foundD] = await Promise.all([
    c.waitFor('s.match.found'),
    d.waitFor('s.match.found'),
  ]);
  ok('双方匹配成功', foundC.room.id === foundD.room.id);

  // 客户端依赖 s.room.joined 切换到大厅→房间视图，匹配路径必须补发该事件
  const joinedC = c.last('s.room.joined');
  const joinedD = d.last('s.room.joined');
  ok('双方均收到进房事件（客户端切视图依据）',
    !!joinedC && !!joinedD && joinedC.room.id === joinedD.room.id);

  const startC = c.last('s.game.start') || (await c.waitFor('s.game.start'));
  const startD = d.last('s.game.start') || (await d.waitFor('s.game.start'));
  ok('匹配对局自动开始', startC.roomId === startD.roomId);

  // 走一子验证
  c.send('game.move', { move: { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } } });
  await d.waitFor('s.game.move');
  ok('匹配对局可正常走子', true);

  c.close();
  d.close();
}

async function testSpectate() {
  console.log('\n[3] 观战：对局进行中第三人加入观战');
  const g = new Client();
  const h = new Client();
  const i = new Client();
  const userH = await auth(g, { name: randName('观主G'), password: 'pass1234' });
  await auth(h, { name: randName('棋手H'), password: 'pass1234' });
  await auth(i, { name: randName('观战I'), password: 'pass1234' });

  g.send('room.create', { gameType: 'xiangqi' });
  const joined = await g.waitFor('s.room.joined');
  h.send('room.join', { roomId: joined.room.id });
  await h.waitFor('s.room.joined');
  g.send('room.ready', { ready: true });
  h.send('room.ready', { ready: true });
  await sleep(150);
  g.send('room.start');
  await g.waitFor('s.game.start');

  // 走一步后再让 I 观战
  g.send('game.move', { move: { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } } });
  await h.waitFor('s.game.move');

  i.send('room.join', { roomId: joined.room.id });
  const spec = await i.waitFor('s.room.joined');
  ok('观战者成功加入', spec.spectator === true, JSON.stringify(spec));
  ok('观战者拿到棋盘状态', spec.room?.game?.board?.flat()?.filter(Boolean)?.length === 32,
    `pieces=${spec.room?.game?.board?.flat()?.filter(Boolean)?.length}`);
  ok('观战者看到已走的一手', spec.room?.game?.moveCount === 1);

  // 观战者不能走子
  i.send('game.move', { move: { from: { x: 0, y: 9 }, to: { x: 0, y: 8 } } });
  const err = await i.waitFor('s.error');
  ok('观战者走子被拒', !!err, err?.code);

  // H 认输 → G 胜
  h.send('game.surrender');
  const over = await g.waitFor('s.game.over');
  ok('认输后对手获胜', over.winnerId === userH.id, `winner=${over.winnerId}`);

  g.close(); h.close(); i.close();
}

async function testGuestAndDisconnect() {
  console.log('\n[4] 游客 + 掉线判负');
  const k = new Client();
  const j = new Client();
  await k.connected;
  const pGAuth = k.waitFor('s.auth.ok');
  const pGState = k.waitFor('s.me.state');
  k.send('auth.guest');
  const [guest] = await Promise.all([pGAuth, pGState]);
  ok('游客登录成功', guest.user.isGuest === true);

  const userJ = await auth(j, { name: randName('留手J'), password: 'pass1234' });

  k.send('room.create', { gameType: 'xiangqi' });
  const joined = await k.waitFor('s.room.joined');
  j.send('room.join', { roomId: joined.room.id });
  await j.waitFor('s.room.joined');
  k.send('room.ready', { ready: true });
  j.send('room.ready', { ready: true });
  await sleep(150);
  k.send('room.start');
  await j.waitFor('s.game.start');

  // 游客掉线 → 立即判负
  const overP = j.waitFor('s.game.over');
  k.close();
  const over = await overP;
  ok('游客掉线后对手获胜', over.winnerId === userJ.id, `winner=${over.winnerId}`);
  ok('判负原因为离开', /离开|掉线|认输/.test(over.reason || ''), over.reason);

  j.close();
}

async function testChatAndRest() {
  console.log('\n[5] 聊天 + REST 接口');
  const m = new Client();
  const n = new Client();
  await auth(m, { name: randName('聊手M'), password: 'pass1234' });
  await auth(n, { name: randName('聊手N'), password: 'pass1234' });

  m.send('chat.send', { text: '大家好', scope: 'lobby' });
  const chat = await n.waitFor('s.chat');
  ok('大厅聊天广播成功', chat.text === '大家好' && chat.scope === 'lobby');

  const reg = await fetch(`${HTTP_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: randName('REST手'), password: 'pass1234' }),
  }).then((r) => r.json());
  ok('REST 注册成功', reg.ok === true && reg.token);

  const me = await fetch(`${HTTP_URL}/api/users/me`, {
    headers: { Authorization: `Bearer ${reg.token}` },
  }).then((r) => r.json());
  ok('REST 令牌鉴权成功', me.ok === true && me.user.id === reg.user.id);

  const lb = await fetch(`${HTTP_URL}/api/leaderboard`).then((r) => r.json());
  ok('REST 排行榜可用', lb.ok === true && Array.isArray(lb.rankings));

  const rooms = await fetch(`${HTTP_URL}/api/rooms`).then((r) => r.json());
  ok('REST 房间列表可用', rooms.ok === true && Array.isArray(rooms.rooms));

  const matches = await fetch(`${HTTP_URL}/api/matches`).then((r) => r.json());
  ok('REST 历史对局可用', matches.ok === true && matches.matches.length >= 3,
    `matches=${matches.matches?.length}`);

  const games = await fetch(`${HTTP_URL}/api/games`).then((r) => r.json());
  ok('REST 游戏列表含象棋与五子棋',
    games.games?.length === 2
    && games.games.some((g) => g.type === 'xiangqi')
    && games.games.some((g) => g.type === 'gomoku'),
    JSON.stringify(games.games?.map((g) => g.type)));

  const health = await fetch(`${HTTP_URL}/api/health`).then((r) => r.json());
  ok('REST 健康检查正常', health.ok === true);

  m.close(); n.close();
}

async function testReconnectResume() {
  console.log('\n[6] 断线重连恢复房间（正式用户）');
  const o = new Client();
  const p = new Client();
  const userO = await auth(o, { name: randName('重连O'), password: 'pass1234' });
  await auth(p, { name: randName('陪练P'), password: 'pass1234' });

  o.send('room.create', { gameType: 'xiangqi' });
  const joined = await o.waitFor('s.room.joined');
  p.send('room.join', { roomId: joined.room.id });
  await p.waitFor('s.room.joined');

  const authMsg = o.last('s.auth.ok');
  const token = authMsg.token;
  o.close();
  await sleep(300);

  const o2 = new Client();
  await o2.connected;
  o2.send('auth.login', { token });
  const stateMsg = await o2.waitFor('s.me.state');
  ok('重连后恢复房间', stateMsg.room && stateMsg.room.id === joined.room.id);
  ok('房间中在线状态恢复', stateMsg.room.players.find((x) => x.id === userO.id)?.online === true);

  o2.close(); p.close();
}

async function testSingleSession() {
  console.log('\n[7] 单端登录：同一账号新设备登录会顶掉旧设备');
  const x = new Client();
  const y = new Client();
  const name = randName('顶号X');
  await auth(x, { name, password: 'pass1234' });
  const tokenX = x.last('s.auth.ok').token;

  // 第二台设备用相同账号密码登录 → 旧连接应被顶下线
  const pKick = x.waitFor('s.auth.kicked');
  const pClose = new Promise((res) => {
    x.ws.on('close', (code, reason) => res({ code, reason: reason.toString() }));
  });
  await auth(y, { name, password: 'pass1234', register: false });
  const kick = await pKick;
  ok('旧连接收到顶号事件', !!kick && /其他设备/.test(kick.message || ''), kick?.message);
  const close = await pClose;
  ok('旧连接被关闭(close code 4001)', close && close.code === 4001, `code=${close?.code} reason=${close?.reason}`);

  // 新连接可正常工作
  y.send('room.create', { gameType: 'xiangqi' });
  const joined = await y.waitFor('s.room.joined');
  ok('新设备可正常建房', !!joined.room);

  // 旧令牌已失效：重新连接用旧令牌登录被拒
  const z = new Client();
  await z.connected;
  z.send('auth.login', { token: tokenX });
  const err = await z.waitFor('s.error');
  ok('旧令牌已失效(AUTH_TOKEN_INVALID)', !!err && err.code === 'AUTH_TOKEN_INVALID', err?.code);

  // 同一令牌断线重连不应被顶号，且可恢复房间
  const tokenY = y.last('s.auth.ok').token;
  y.close();
  await sleep(300);
  const y2 = new Client();
  await y2.connected;
  y2.send('auth.login', { token: tokenY });
  const state2 = await y2.waitFor('s.me.state');
  ok('同令牌重连不被顶号并恢复房间', state2.room && state2.room.id === joined.room.id);

  x.close(); y2.close(); z.close();
}

async function testAdminUsers() {
  console.log('\n[8] 管理后台：创建 / 删除用户');
  const name = randName('后台用户');
  const create = await fetch(`${HTTP_URL}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: 'pass1234' }),
  }).then((r) => r.json());
  ok('管理员创建用户成功', create.ok === true && create.user?.name === name && create.user?.isGuest === false,
    JSON.stringify(create));

  // 新账号可正常登录（WS + REST）
  const c = new Client();
  const user = await auth(c, { name, password: 'pass1234', register: false });
  ok('新账号可登录', user.name === name);
  c.close();

  const dup = await fetch(`${HTTP_URL}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: 'pass1234' }),
  }).then((r) => r.json());
  ok('重复昵称创建被拒绝', dup.ok !== true, dup.message || '');

  const badName = await fetch(`${HTTP_URL}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x', password: 'pass1234' }),
  }).then((r) => r.json());
  ok('非法昵称创建被拒绝', badName.ok !== true, badName.message || '');

  const del = await fetch(`${HTTP_URL}/api/admin/users?id=${encodeURIComponent(user.id)}`, {
    method: 'DELETE',
  }).then((r) => r.json());
  ok('管理员删除用户成功', del.ok === true, JSON.stringify(del));

  const relogin = await fetch(`${HTTP_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: 'pass1234' }),
  }).then((r) => r.json());
  ok('删除后账号无法登录', relogin.ok !== true, relogin.message || '');

  const delMissing = await fetch(`${HTTP_URL}/api/admin/users?id=99999999`, { method: 'DELETE' }).then((r) => r.json());
  ok('删除不存在的用户返回错误', delMissing.ok !== true, delMissing.message || '');

  const batchNames = [randName('批删A'), randName('批删B'), randName('批删C')];
  const batchUsers = [];
  for (const n of batchNames) {
    const r = await fetch(`${HTTP_URL}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: n, password: 'pass1234' }),
    }).then((x) => x.json());
    batchUsers.push(r.user);
  }
  ok('批量删除前创建 3 个用户', batchUsers.every((u) => u?.id), JSON.stringify(batchUsers));

  const batchDel = await fetch(`${HTTP_URL}/api/admin/users`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [batchUsers[0].id, batchUsers[1].id, '99999999'] }),
  }).then((r) => r.json());
  ok('JSON 批量删除部分成功',
    batchDel.ok === true && batchDel.deleted?.length === 2 && Array.isArray(batchDel.notFound) && batchDel.notFound.includes('99999999'),
    JSON.stringify(batchDel));

  const viaQuery = await fetch(`${HTTP_URL}/api/admin/users?ids=${encodeURIComponent(batchUsers[2].id)}`, {
    method: 'DELETE',
  }).then((r) => r.json());
  ok('ids 查询参数删除成功',
    viaQuery.ok === true && viaQuery.deleted?.some((d) => String(d.id) === String(batchUsers[2].id)),
    JSON.stringify(viaQuery));

  const stillThere = await fetch(`${HTTP_URL}/api/admin/users?search=${encodeURIComponent(batchNames[0])}`).then((r) => r.json());
  ok('批量删除后账号不再出现在列表', (stillThere.users || []).every((u) => !batchNames.includes(u.name)), JSON.stringify(stillThere));

  const noId = await fetch(`${HTTP_URL}/api/admin/users`, { method: 'DELETE' }).then((r) => r.json());
  ok('缺少 id 时删除被拒绝', noId.ok !== true, noId.message || '');
}

async function testDrawOffer() {
  console.log('\n[9] 求和协议：提出 → 同意 → 和棋结束');
  const a = new Client();
  const b = new Client();
  await auth(a, { name: randName('和棋A'), password: 'pass1234' });
  await auth(b, { name: randName('和棋B'), password: 'pass1234' });

  a.send('room.create', { gameType: 'xiangqi' });
  const joined = await a.waitFor('s.room.joined');
  b.send('room.join', { roomId: joined.room.id });
  await b.waitFor('s.room.joined');
  a.send('room.config', { timeLimit: 60, gameTime: 300, firstMove: 'owner' });
  await sleep(100);
  a.send('room.ready', { ready: true });
  b.send('room.ready', { ready: true });
  await sleep(100);
  a.send('room.start');
  const start = await a.waitFor('s.game.start');
  ok('开局含 gameTime/clocks', start.game?.gameTime === 300 && !!start.game?.clocks, JSON.stringify({
    gameTime: start.game?.gameTime,
    clocks: start.game?.clocks,
  }));

  a.send('game.drawOffer');
  const req = await b.waitFor('s.draw.requested');
  ok('对方收到求和请求', req.byName && !req.mine, JSON.stringify(req));
  b.send('game.drawRespond', { agree: true });
  const over = await a.waitFor('s.game.over');
  ok('协商和棋结束', over.isDraw === true, JSON.stringify(over));
  ok('原因含协商或和棋', /协商|和棋/.test(over.reason || ''), over.reason);

  a.close();
  b.close();
}

async function main() {
  console.log('====================================');
  console.log('对战平台（中国象棋）端到端自测开始');
  console.log(`WS: ${WS_URL}`);
  console.log('====================================');

  await testXiangqiFullGame();
  await testGomokuFullGame();
  await testMatchmaking();
  await testSpectate();
  await testGuestAndDisconnect();
  await testChatAndRest();
  await testReconnectResume();
  await testSingleSession();
  await testAdminUsers();
  await testDrawOffer();

  console.log('\n====================================');
  console.log(`自测结果：通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('全部通过 ✅');
  process.exit(0);
}

main().catch((err) => {
  console.error('自测异常中断:', err);
  process.exit(1);
});
