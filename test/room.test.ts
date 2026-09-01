/**
 * 房间层测试：悔棋流程（请求/同意/撤销）与走子超时判负
 * 运行：npx tsx test/room.test.ts
 */
import { config } from '../src/config.js';
import { RoomManager } from '../src/core/room.js';
import { logger } from '../src/log/logger.js';

let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await logger.init();
  config.moveTimeLimit = 2; // 本测试用 2 秒限时验证超时判负

  const sent = [];
  const io = {
    send: (userId, msg) => sent.push({ to: [userId], msg }),
    sendToMany: (ids, msg) => sent.push({ to: ids, msg }),
    broadcastAll: (msg) => sent.push({ to: ['*'], msg }),
  };
  const rooms = new RoomManager(io);

  const userA = { id: 'u1', name: '甲' };
  const userB = { id: 'u2', name: '乙' };

  function newGame() {
    rooms.leaveRoom('u1');
    rooms.leaveRoom('u2');
    const c = rooms.createRoom(userA, { gameType: 'xiangqi' });
    rooms.joinRoom(userB, c.room.id);
    rooms.setReady('u1', true);
    rooms.setReady('u2', true);
    rooms.startGame('u1');
    return c.room.id;
  }

  function lastEvent(type) {
    return [...sent].reverse().find((e) => e.msg.type === type)?.msg;
  }

  console.log('[1] 悔棋流程：请求 → 同意 → 撤销一步');
  {
    sent.length = 0;
    const roomId = newGame();
    ok('对局开始', !!lastEvent('s.game.start'));

    rooms.applyMove('u1', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } }); // 红炮
    rooms.applyMove('u2', { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } }); // 黑马
    const mv = lastEvent('s.game.move');
    ok('两步后轮到红方', mv && mv.turn === 0, JSON.stringify(mv?.turn));

    // u1 请求悔棋
    const req = rooms.undoRequest('u1');
    ok('请求悔棋成功', req.ok === true, JSON.stringify(req));
    const reqEvt = lastEvent('s.undo.requested');
    ok('对方收到悔棋请求', !!reqEvt && reqEvt.byName === '甲', JSON.stringify(reqEvt));

    // 非对方不能回应
    const bad = rooms.undoRespond('u1', true);
    ok('不能回应自己的请求', bad.error === 'BAD_REQUEST');

    // u2 同意 → 撤销黑马一步
    const resp = rooms.undoRespond('u2', true);
    ok('同意悔棋成功', resp.ok === true, JSON.stringify(resp));
    const done = lastEvent('s.undo.done');
    ok('撤销广播 UNDO_DONE', !!done, JSON.stringify(done));
    ok('撤销后步数为 1', done?.game?.moveCount === 1, `moves=${done?.game?.moveCount}`);
    ok('黑马回到原位', done?.game?.board?.[0]?.[1] === 'bh');
    ok('撤销后轮到黑方', done?.game?.turn === 1, `turn=${done?.game?.turn}`);
  }

  console.log('[2] 悔棋被拒绝');
  {
    sent.length = 0;
    newGame();
    rooms.applyMove('u1', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } });
    rooms.undoRequest('u1');
    rooms.undoRespond('u2', false);
    const resp = lastEvent('s.undo.response');
    ok('对方收到拒绝回应', !!resp && resp.agree === false, JSON.stringify(resp));
    ok('对局未受影响（步数仍为 1）', lastEvent('s.game.move')?.game?.moveCount === 1);
  }

  console.log('[3] 走子超时判负（2 秒限时）');
  {
    sent.length = 0;
    newGame();
    // 红方先手，2 秒内不走子 → 红方超时判负
    await sleep(3200);
    const over = lastEvent('s.game.over');
    ok('超时后收到 GAME_OVER', !!over, JSON.stringify(over));
    ok('超时判负方为红方', over?.reason?.includes('超时'), over?.reason);
    ok('对手获胜', over?.winnerId === 'u2', `winner=${over?.winnerId}`);
    // 对局结束后不能再走子
    ok('结束后走子被拒', rooms.applyMove('u1', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } }).error === 'INVALID_MOVE');
  }

  console.log('[4] 对局中走子后重新计时（超时不触发）');
  {
    sent.length = 0;
    newGame();
    rooms.applyMove('u1', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } });
    await sleep(2600); // 红方已走，超过 2 秒但轮到黑方，黑方也应超时
    const over = lastEvent('s.game.over');
    ok('黑方超时判负', !!over && over.winnerId === 'u1', JSON.stringify(over));
  }

  console.log('[5] 人机模式：玩家走子 → 电脑自动回应 → 电脑不超时');
  {
    sent.length = 0;
    rooms.leaveRoom('u1');
    // 创建人机房间
    const c = rooms.createRoom(userA, { gameType: 'xiangqi', vsAI: true });
    ok('创建人机房间成功', c.ok === true, JSON.stringify(c));
    ok('房间模式为 ai', c.room.mode === 'ai');
    ok('电脑玩家已加入并就绪', c.room.players.length === 2 && c.room.players.some((p) => p.name === '电脑' && p.ready));
    // 其他玩家不能加入人机房间
    const joinDenied = rooms.joinRoom(userB, c.room.id);
    ok('人机房间拒绝其他玩家加入', joinDenied.error === 'BAD_REQUEST', JSON.stringify(joinDenied));
    // 玩家就绪并开始
    rooms.setReady('u1', true);
    rooms.startGame('u1');
    ok('人机对局开始', !!lastEvent('s.game.start'));

    // 玩家（红方）走一步
    rooms.applyMove('u1', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } });
    // 轮询等待电脑回应（引擎思考约 1.5-3 秒，玩家 2 秒限时内必须完成悔棋）
    let aiMove = null;
    for (let i = 0; i < 100 && !aiMove; i++) {
      aiMove = [...sent].reverse().find((e) => e.msg.type === 's.game.move' && e.msg.playerId === '__ai__');
      if (!aiMove) await sleep(100);
    }
    ok('电脑自动走了一步', !!aiMove, JSON.stringify(aiMove?.msg?.move));
    ok('电脑走法有着法', !!aiMove?.msg?.game?.moves?.at(-1)?.notation, aiMove?.msg?.game?.moves?.at(-1)?.notation);
    ok('电脑走完后轮到玩家', aiMove?.msg?.turn === 0, `turn=${aiMove?.msg?.turn}`);

    // 人机悔棋：无需对方同意，直接撤销（撤销的是电脑刚走的一步 → 轮到电脑）
    sent.length = 0;
    const undo = rooms.undoRequest('u1');
    ok('人机悔棋直接生效', undo.ok === true, JSON.stringify(undo));
    const undone = lastEvent('s.undo.done');
    ok('悔棋广播 UNDO_DONE', !!undone, JSON.stringify(undone));
    ok('悔棋后步数减一', undone?.game?.moveCount === 1, `moves=${undone?.game?.moveCount}`);
    ok('悔棋后轮到电脑', undone?.game?.turn === 1, `turn=${undone?.game?.turn}`);

    // 电脑回合：等待超过限时（2 秒）无超时判负，且电脑会重新思考走子
    await sleep(3000);
    const overDuringAi = lastEvent('s.game.over');
    ok('电脑回合不触发超时判负', !overDuringAi, JSON.stringify(overDuringAi));
    const aiMove2 = [...sent].reverse().find((e) => e.msg.type === 's.game.move' && e.msg.playerId === '__ai__');
    ok('悔棋后电脑重新走子', !!aiMove2, JSON.stringify(aiMove2?.msg?.move));
  }

  console.log('[6] 五子棋房间：建房 → 落子 → 五连结束');
  {
    sent.length = 0;
    rooms.leaveRoom('u1');
    rooms.leaveRoom('u2');
    const c = rooms.createRoom(userA, { gameType: 'gomoku' });
    ok('创建五子棋房间', c.ok === true && c.room.gameType === 'gomoku', JSON.stringify(c));
    rooms.joinRoom(userB, c.room.id);
    rooms.setReady('u1', true);
    rooms.setReady('u2', true);
    rooms.startGame('u1');
    ok('五子棋对局开始', lastEvent('s.game.start')?.game?.type === 'gomoku');

    const seq = [
      ['u1', 7, 7], ['u2', 0, 0],
      ['u1', 8, 7], ['u2', 0, 1],
      ['u1', 9, 7], ['u2', 0, 2],
      ['u1', 10, 7], ['u2', 0, 3],
      ['u1', 11, 7],
    ];
    let last = null;
    for (const [uid, x, y] of seq) last = rooms.applyMove(uid, { x, y });
    ok('黑方五连房间层判胜', last.ok === true, JSON.stringify(last));
    const over = lastEvent('s.game.over');
    ok('广播 GAME_OVER', !!over && over.winnerId === 'u1', JSON.stringify(over));
    ok('原因含五子连珠', over?.reason?.includes('五子连珠'));
  }

  console.log('[7] 五子棋人机：玩家落子后电脑回应');
  {
    sent.length = 0;
    rooms.leaveRoom('u1');
    const c = rooms.createRoom(userA, { gameType: 'gomoku', vsAI: true });
    ok('创建五子棋人机房', c.ok === true && c.room.mode === 'ai');
    rooms.setReady('u1', true);
    rooms.startGame('u1');
    rooms.applyMove('u1', { x: 7, y: 7 });
    let aiMove = null;
    for (let i = 0; i < 40 && !aiMove; i++) {
      aiMove = [...sent].reverse().find((e) => e.msg.type === 's.game.move' && e.msg.playerId === '__ai__');
      if (!aiMove) await sleep(50);
    }
    ok('五子棋电脑自动落子', !!aiMove, JSON.stringify(aiMove?.msg?.move));
    ok('电脑落在空点', aiMove?.msg?.move?.x !== 7 || aiMove?.msg?.move?.y !== 7);
  }

  console.log('[8] 对局设置：时限与先后手');
  {
    sent.length = 0;
    rooms.leaveRoom('u1');
    rooms.leaveRoom('u2');
    const c = rooms.createRoom(userA, { gameType: 'xiangqi' });
    rooms.joinRoom(userB, c.room.id);

    // 校验：非房主 / 非法值
    ok('非房主修改被拒', rooms.setConfig('u2', { timeLimit: 30 }).error === 'NOT_OWNER');
    ok('观战外用户修改被拒', rooms.setConfig('ghost', { timeLimit: 30 }).error === 'NOT_IN_ROOM');
    ok('时限过小被拒', rooms.setConfig('u1', { timeLimit: 1 }).error === 'BAD_REQUEST');
    ok('时限过大被拒', rooms.setConfig('u1', { timeLimit: 601 }).error === 'BAD_REQUEST');
    ok('非法先后手被拒', rooms.setConfig('u1', { firstMove: 'x' }).error === 'BAD_REQUEST');

    // 合法设置并广播
    const r = rooms.setConfig('u1', { timeLimit: 45, firstMove: 'opponent' });
    ok('房主设置成功', r.ok === true, JSON.stringify(r));
    ok('设置已广播到房间视图', lastEvent('s.room.update')?.room?.config?.timeLimit === 45
      && lastEvent('s.room.update')?.room?.config?.firstMove === 'opponent');

    // 开局：乙（对方）执红先手，每步 45 秒
    rooms.setReady('u1', true);
    rooms.setReady('u2', true);
    rooms.startGame('u1');
    const st = lastEvent('s.game.start');
    ok('按设置时限开局', st?.game?.timeLimit === 45, `limit=${st?.game?.timeLimit}`);
    ok('对方成为先手方', st?.game?.players?.[0]?.id === 'u2' && st?.game?.players?.[1]?.id === 'u1',
      JSON.stringify(st?.game?.players));

    // 先手方走子生效，后手方走子被拒
    const mv = rooms.applyMove('u2', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } });
    ok('先手方走子成功', mv.ok === true, JSON.stringify(mv));
    ok('后手方此时走子被拒', rooms.applyMove('u1', { from: { x: 3, y: 0 }, to: { x: 3, y: 3 } }).error === 'INVALID_MOVE');

    // 开局后不能再改设置
    ok('开局后修改被拒', rooms.setConfig('u1', { timeLimit: 300 }).error === 'GAME_ALREADY_STARTED');
  }

  console.log('[9] 对局设置：人机房间让电脑先手');
  {
    sent.length = 0;
    rooms.leaveRoom('u1');
    const c = rooms.createRoom(userA, { gameType: 'gomoku', vsAI: true });
    ok('人机房默认房主先手', c.room.config?.firstMove === 'owner', JSON.stringify(c.room.config));
    const r = rooms.setConfig('u1', { firstMove: 'opponent' });
    ok('设置电脑先手成功', r.ok === true && r.config.firstMove === 'opponent', JSON.stringify(r));
    rooms.setReady('u1', true);
    rooms.startGame('u1');
    const st = lastEvent('s.game.start');
    ok('电脑成为先手方', st?.game?.players?.[0]?.id === '__ai__', JSON.stringify(st?.game?.players));
    // 无需玩家落子，电脑应自动走出第一手
    let aiMove = null;
    for (let i = 0; i < 60 && !aiMove; i++) {
      aiMove = [...sent].reverse().find((e) => e.msg.type === 's.game.move' && e.msg.playerId === '__ai__');
      if (!aiMove) await sleep(100);
    }
    ok('电脑自动走了第一手', !!aiMove, JSON.stringify(aiMove?.msg?.move));
    const g = aiMove?.msg?.game;
    ok('电脑走完后轮到玩家', !!g && g.players[g.turn]?.id === 'u1', `turn=${aiMove?.msg?.turn}`);
  }

  console.log('[10] 走法提示：私有下发 + 建议走法合法');
  {
    sent.length = 0;
    rooms.leaveRoom('u1');
    rooms.leaveRoom('u2');
    const c = rooms.createRoom(userA, { gameType: 'xiangqi' });
    rooms.joinRoom(userB, c.room.id);
    rooms.setReady('u1', true);
    rooms.setReady('u2', true);
    rooms.startGame('u1');

    // 校验：不在房间 / 未轮到 / 对局未开始
    ok('房间外请求被拒', (await rooms.hintFor('ghost')).error === 'NOT_IN_ROOM');
    ok('未轮到方请求被拒', (await rooms.hintFor('u2')).error === 'NOT_YOUR_TURN');

    // u1（红先）请求提示
    const h1 = await rooms.hintFor('u1');
    ok('轮到方能拿到提示', h1.ok === true && !!h1.move, JSON.stringify(h1));
    const hintEvt = [...sent].reverse().find((e) => e.msg.type === 's.hint');
    ok('提示仅私发给请求方', !!hintEvt && hintEvt.to.length === 1 && hintEvt.to[0] === 'u1', JSON.stringify(hintEvt?.to));
    ok('提示不广播给对手', ![...sent].some((e) => e.msg.type === 's.hint' && e.to.includes('u2')));
    // 提示的走法可直接落子
    const mv = rooms.applyMove('u1', h1.move);
    ok('按提示走子成功', mv.ok === true, JSON.stringify(mv));

    // 走子后轮到黑方（u2），黑方请求提示应被拒
    const hb = await rooms.hintFor('u2');
    ok('黑方请求提示被拒', hb.error === 'BAD_REQUEST' && /黑方/.test(hb.message || ''), JSON.stringify(hb));

    // 对局结束后不能再提示
    rooms.surrender('u2');
    const after = await rooms.hintFor('u1');
    ok('对局结束提示被拒', after.error === 'BAD_REQUEST', JSON.stringify(after));
  }

  console.log('[11] 五子棋不支持走法提示');
  {
    sent.length = 0;
    rooms.leaveRoom('u1');
    rooms.leaveRoom('u2');
    const c = rooms.createRoom(userA, { gameType: 'gomoku' });
    rooms.joinRoom(userB, c.room.id);
    rooms.setReady('u1', true);
    rooms.setReady('u2', true);
    rooms.startGame('u1');
    const h = await rooms.hintFor('u1');
    ok('五子棋提示被拒', h.error === 'BAD_REQUEST', JSON.stringify(h));
    ok('未下发 s.hint', ![...sent].some((e) => e.msg.type === 's.hint'));
  }

  console.log('[12] 求和：提出 / 同意 / 拒绝 / 冷却 / 人机自动应答');
  {
    sent.length = 0;
    const roomId = newGame();
    ok('对局开始(求和)', !!lastEvent('s.game.start'));

    const offer = rooms.offerDraw('u1');
    ok('提和成功', offer.ok === true, JSON.stringify(offer));
    const reqEvt = lastEvent('s.draw.requested');
    ok('对方收到求和请求', !!reqEvt && reqEvt.byName === '甲', JSON.stringify(reqEvt));

    const badSelf = rooms.respondDraw('u1', true);
    ok('不能回应自己的求和', badSelf.error === 'BAD_REQUEST');

    const agree = rooms.respondDraw('u2', true);
    ok('同意求和成功', agree.ok === true, JSON.stringify(agree));
    const over = lastEvent('s.game.over');
    ok('和棋结束', !!over && over.isDraw === true, JSON.stringify(over));
    ok('原因含协商', /协商|和棋/.test(over?.reason || ''), over?.reason);

    // 拒绝 + 冷却
    sent.length = 0;
    newGame();
    rooms.offerDraw('u1');
    rooms.respondDraw('u2', false);
    const rej = lastEvent('s.draw.response');
    ok('拒绝求和通知', !!rej && rej.agree === false, JSON.stringify(rej));
    const cool = rooms.offerDraw('u1');
    ok('被拒后立即再提被拒', cool.error === 'BAD_REQUEST', JSON.stringify(cool));
    // 走满 4 步后再提
    rooms.applyMove('u1', { from: { x: 1, y: 7 }, to: { x: 1, y: 5 } });
    rooms.applyMove('u2', { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } });
    rooms.applyMove('u1', { from: { x: 7, y: 9 }, to: { x: 6, y: 7 } });
    rooms.applyMove('u2', { from: { x: 7, y: 0 }, to: { x: 6, y: 2 } });
    const again = rooms.offerDraw('u1');
    ok('冷却后可再提和', again.ok === true, JSON.stringify(again));
    rooms.respondDraw('u2', false);

    // 人机：不支持求和
    sent.length = 0;
    rooms.leaveRoom('u1');
    rooms.leaveRoom('u2');
    const ai = rooms.createRoom(userA, { gameType: 'xiangqi', vsAI: true });
    rooms.setReady('u1', true);
    rooms.startGame('u1');
    const aiOffer = rooms.offerDraw('u1');
    ok('人机提和被拒', aiOffer.error === 'BAD_REQUEST' && /人机/.test(aiOffer.message || ''), JSON.stringify(aiOffer));
    ok('人机未下发求和事件', ![...sent].some((e) => e.msg.type === 's.draw.requested' || e.msg.type === 's.draw.response'));
    void roomId;
    void ai;
  }

  console.log('[13] 局时+步时：配置与局时耗尽判负');
  {
    sent.length = 0;
    rooms.leaveRoom('u1');
    rooms.leaveRoom('u2');
    const c = rooms.createRoom(userA, { gameType: 'xiangqi' });
    rooms.joinRoom(userB, c.room.id);
    const cfg = rooms.setConfig('u1', { timeLimit: 60, gameTime: 60 });
    ok('设置局时成功', cfg.ok && cfg.config.gameTime === 60, JSON.stringify(cfg));
    rooms.setReady('u1', true);
    rooms.setReady('u2', true);
    rooms.startGame('u1');
    const st = lastEvent('s.game.start');
    ok('开局携带 clocks', !!st?.game?.clocks && st.game.clocks.u1 === 60000, JSON.stringify(st?.game?.clocks));

    // 人为把红方局时压到极小并触发超时定时器
    rooms.leaveRoom('u1');
    rooms.leaveRoom('u2');
    config.moveTimeLimit = 2;
    const c2 = rooms.createRoom(userA, { gameType: 'xiangqi' });
    rooms.joinRoom(userB, c2.room.id);
    // 步时下限为 5 秒；局时 60 秒。超时由 clocks 剩余决定
    const cfg2 = rooms.setConfig('u1', { timeLimit: 5, gameTime: 60 });
    ok('短局设置成功', cfg2.ok === true, JSON.stringify(cfg2));
    rooms.setReady('u1', true);
    rooms.setReady('u2', true);
    rooms.startGame('u1');
    const room = rooms.rooms.get(c2.room.id);
    ok('开局 clocks 非空', !!room?.game?.clocks, JSON.stringify(room?.game?.clocks));
    room.game.clocks.u1 = 50;
    rooms._clearTurnTimer(room);
    rooms._scheduleTurnTimeout(room);
    await sleep(400);
    const over = lastEvent('s.game.over');
    ok('局时耗尽判负', !!over && over.winnerId === 'u2', JSON.stringify(over));
    ok('原因含局时', /局时/.test(over?.reason || ''), over?.reason);
  }

  console.log(`\n房间层测试：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
