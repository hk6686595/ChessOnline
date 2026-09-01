/**
 * 好友关系单元测试
 * 运行：npx tsx test/friend.test.ts
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { paths } from '../src/config.js';
import { store } from '../src/db/store.js';
import * as userApi from '../src/core/user.js';
import { logger } from '../src/log/logger.js';

let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

async function main() {
  await logger.init();
  const tmp = path.join(os.tmpdir(), `friendtest-${Date.now()}.db`);
  paths.dbFile = tmp;
  await store.init();

  const mk = (id, name) => {
    store.data.users[id] = { id, name, isGuest: false, rating: 1000, wins: 0, losses: 0, draws: 0, createdAt: Date.now(), lastSeen: Date.now() };
  };
  mk('fa', 'FriendA');
  mk('fb', 'FriendB');
  mk('fc', 'FriendC');

  // 1. 发起好友请求
  const r1 = userApi.sendFriendRequest('fa', 'FriendB');
  ok('发起好友请求成功', r1.ok === true, JSON.stringify(r1));
  ok('待处理时非好友', userApi.isFriend('fa', 'fb') === false);

  const rself = userApi.sendFriendRequest('fa', 'FriendA');
  ok('不能添加自己', rself.error === 'FRIEND_SELF', JSON.stringify(rself));

  const rdup = userApi.sendFriendRequest('fa', 'FriendB');
  ok('重复请求被拒', rdup.error === 'FRIEND_REQUEST_EXISTS', JSON.stringify(rdup));

  const rnone = userApi.sendFriendRequest('fa', 'NoBody');
  ok('添加不存在用户失败', rnone.error === 'FRIEND_NOT_FOUND', JSON.stringify(rnone));

  // 2. 接受请求（B 接受 A 的请求）
  const r2 = userApi.acceptFriendRequest('fb', 'fa');
  ok('B 接受请求成功', r2.ok === true, JSON.stringify(r2));
  ok('已成为好友', userApi.isFriend('fa', 'fb') === true);
  ok('已是好友再请求被拒', userApi.sendFriendRequest('fa', 'FriendB').error === 'ALREADY_FRIENDS');

  // 2b. 重复接受同一请求幂等，不产生重复好友记录
  const r2b = userApi.acceptFriendRequest('fb', 'fa');
  ok('重复接受幂等成功', r2b.ok === true, JSON.stringify(r2b));
  const faFriends = userApi.getFriends('fa');
  ok('好友列表无重复', faFriends.filter((f) => f.id === 'fb').length === 1, JSON.stringify(faFriends));

  // 3. 待处理请求列表
  userApi.sendFriendRequest('fa', 'FriendC');
  ok('C 收到 incoming', userApi.getIncomingRequests('fc').some((f) => f.id === 'fa'));
  ok('A 有 outgoing', userApi.getOutgoingRequests('fa').some((f) => f.id === 'fc'));

  // 4. 拒绝
  const rj = userApi.rejectFriendRequest('fc', 'fa');
  ok('C 拒绝成功', rj.ok === true, JSON.stringify(rj));
  ok('拒绝后不再是 outgoing', !userApi.getOutgoingRequests('fa').some((f) => f.id === 'fc'));

  // 5. 删除好友
  const rm = userApi.removeFriend('fa', 'fb');
  ok('删除好友成功', rm.ok === true, JSON.stringify(rm));
  ok('删除后非好友', userApi.isFriend('fa', 'fb') === false);

  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
