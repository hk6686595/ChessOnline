/**
 * WebSocket 消息协议定义
 *
 * 所有消息均为 JSON：{ type: string, ...payload }
 * 服务端主动推送的 type 前缀为 "s."（server），客户端请求为普通字符串。
 */

/** 错误码 */
export const ERR = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID', // 令牌失效（已过期 / 被其他设备顶号）
  NAME_TAKEN: 'NAME_TAKEN',
  NAME_INVALID: 'NAME_INVALID',
  PASSWORD_INVALID: 'PASSWORD_INVALID',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_LOCKED: 'ROOM_LOCKED',
  WRONG_PASSWORD: 'WRONG_PASSWORD',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_OWNER: 'NOT_OWNER',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  INVALID_MOVE: 'INVALID_MOVE',
  GAME_NOT_STARTED: 'GAME_NOT_STARTED',
  GAME_ALREADY_STARTED: 'GAME_ALREADY_STARTED',
  ALREADY_MATCHING: 'ALREADY_MATCHING',
  NOT_MATCHING: 'NOT_MATCHING',
  BAD_REQUEST: 'BAD_REQUEST',
  FRIEND_SELF: 'FRIEND_SELF',
  FRIEND_NOT_FOUND: 'FRIEND_NOT_FOUND',
  ALREADY_FRIENDS: 'ALREADY_FRIENDS',
  FRIEND_REQUEST_EXISTS: 'FRIEND_REQUEST_EXISTS',
  NOT_FRIENDS: 'NOT_FRIENDS',
};

/**
 * 服务端 → 客户端 事件类型
 */
export const EVT = {
  WELCOME: 's.welcome',                 // 连接建立
  AUTH_OK: 's.auth.ok',                 // 登录成功 { user, token }
  REGISTER_OK: 's.auth.registered',     // 注册成功（不自动登录）{ name }
  ROOM_LIST: 's.room.list',             // 房间列表 { rooms }
  ROOM_JOINED: 's.room.joined',         // 加入房间 { room }
  ROOM_LEFT: 's.room.left',             // 离开房间 { roomId }
  ROOM_UPDATE: 's.room.update',         // 房间状态变化 { room }
  GAME_START: 's.game.start',           // 游戏开始 { roomId, game }
  GAME_STATE: 's.game.state',           // 游戏状态同步 { roomId, game }
  GAME_MOVE: 's.game.move',             // 走子 { playerId, move, turn, game }
  GAME_OVER: 's.game.over',             // 游戏结束 { winnerId, winnerName, reason, isDraw, game }
  GAME_RESTARTED: 's.game.restarted',   // 重开一局
  HINT: 's.hint',                       // 走法提示（私有下发）{ move: {from,to}, engine }
  UNDO_REQUESTED: 's.undo.requested',   // 悔棋请求 { byUserId, byName, mine? }
  UNDO_RESPONSE: 's.undo.response',     // 悔棋回应 { agree, byName }
  UNDO_DONE: 's.undo.done',             // 悔棋成功（已撤销一步）{ byName, game }
  UNDO_CANCELLED: 's.undo.cancelled',   // 悔棋请求作废 { reason }
  DRAW_REQUESTED: 's.draw.requested',   // 求和请求 { byUserId, byName, mine? }
  DRAW_RESPONSE: 's.draw.response',     // 求和回应 { agree, byName }
  RATING_UPDATE: 's.rating.update',     // 对局后评分/战绩更新 { users }
  MATCH_FOUND: 's.match.found',         // 匹配成功 { room }
  MATCH_QUEUED: 's.match.queued',       // 已进入队列 { gameType, position }
  MATCH_TIMEOUT: 's.match.timeout',     // 匹配超时
  MATCH_LEFT: 's.match.left',           // 退出队列
  CHAT: 's.chat',                       // 聊天 { from, text, ts, scope }
  CHAT_HISTORY: 's.chat.history',       // 大厅聊天历史 { messages }
  CHAT_PRIVATE: 's.chat.private',       // 好友私聊 { fromId, fromName, toId, text, ts }
  RANKING: 's.ranking',                 // 排行榜 { rankings }
  MATCHES: 's.matches',                 // 历史对局列表 { matches }
  MATCH_DETAIL: 's.match.detail',       // 单个对局详情（含棋谱）{ match }
  ME_STATE: 's.me.state',               // 用户当前状态快照 { user, room, matching }
  AUTH_KICKED: 's.auth.kicked',         // 账号在其他设备登录，本连接被顶下线 { message }
  FRIEND_LIST: 's.friend.list',         // 好友与请求快照 { friends:[{id,name,online}], incoming:[{id,name}], outgoing:[{id,name}] }
  FRIEND_REQUEST: 's.friend.request',   // 收到好友请求 { id, name }
  FRIEND_UPDATE: 's.friend.update',     // 好友关系变化（接受/删除/被删）{ }
  AVATAR_UPDATED: 's.avatar.updated',   // 头像已更新 { avatar }
  INVITE: 's.invite',                   // 收到对战邀请 { fromId, fromName, roomId, roomName, gameType, password }
  ERROR: 's.error',                     // 错误 { code, message }
};

/**
 * 客户端 → 服务端 请求类型
 */
export const REQ = {
  AUTH_REGISTER: 'auth.register',
  AUTH_LOGIN: 'auth.login',
  AUTH_GUEST: 'auth.guest',
  ME: 'me',

  ROOM_LIST: 'room.list',
  ROOM_CREATE: 'room.create',
  ROOM_JOIN: 'room.join',
  ROOM_LEAVE: 'room.leave',
  ROOM_READY: 'room.ready',
  ROOM_START: 'room.start',
  ROOM_KICK: 'room.kick',
  ROOM_QUICK_JOIN: 'room.quickJoin',
  ROOM_CONFIG: 'room.config', // 房主修改对局设置 { timeLimit?, gameTime?, firstMove? }（仅等待中）

  MATCH_ENQUEUE: 'match.enqueue',
  MATCH_DEQUEUE: 'match.dequeue',

  GAME_MOVE: 'game.move',
  GAME_RESTART: 'game.restart',
  GAME_SURRENDER: 'game.surrender',
  GAME_HINT: 'game.hint', // 请求走法提示（仅轮到自己时）
  GAME_UNDO_REQUEST: 'game.undoRequest',
  GAME_UNDO_RESPOND: 'game.undoRespond',
  GAME_DRAW_OFFER: 'game.drawOffer',     // 提和
  GAME_DRAW_RESPOND: 'game.drawRespond', // { agree } 回应求和

  CHAT_SEND: 'chat.send',
  CHAT_PRIVATE: 'chat.private',        // { toId, text } 仅好友之间
  RANKING_GET: 'ranking.get',
  MATCHES_GET: 'matches.get', // 查询个人历史对局 { userId? }
  MATCH_DETAIL_GET: 'match.detail.get', // 获取单个对局棋谱 { matchId }
  MATCH_FAVORITE: 'match.favorite',     // 收藏/取消收藏棋谱 { matchId, favorite }（仅参与者）
  MATCH_DELETE: 'match.delete',         // 删除棋谱（仅对自己隐藏）{ matchId }（仅参与者）

  FRIEND_LIST: 'friend.list',
  FRIEND_ADD: 'friend.add',           // { name } 按昵称发起好友请求
  FRIEND_ACCEPT: 'friend.accept',     // { friendId } 接受好友请求
  FRIEND_REJECT: 'friend.reject',     // { friendId } 拒绝好友请求
  FRIEND_REMOVE: 'friend.remove',     // { friendId } 删除好友
  AVATAR_UPDATE: 'avatar.update',     // { avatar } 修改头像
  INVITE_SEND: 'invite.send',        // { friendId, roomId } 邀请好友加入自己的房间
};

/** 可创建房间的游戏类型 */
export const GAME_TYPES = {
  XIANGQI: 'xiangqi',
  GOMOKU: 'gomoku',
};

export const GAME_NAMES = {
  [GAME_TYPES.XIANGQI]: '中国象棋',
  [GAME_TYPES.GOMOKU]: '五子棋',
};

export type GameType = typeof GAME_TYPES.XIANGQI | typeof GAME_TYPES.GOMOKU;

export function isValidGameType(type: unknown): type is GameType {
  return type === GAME_TYPES.XIANGQI || type === GAME_TYPES.GOMOKU;
}
