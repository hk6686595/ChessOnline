/**
 * 游戏注册表与通用接口
 *
 * 每个游戏实现：
 *   type              string  游戏类型标识
 *   name              string  中文名
 *   minPlayers        number  最少玩家
 *   maxPlayers        number  最多玩家（不含观战）
 *   supportsSpectate  boolean 是否允许观战
 *   create(players)   创建初始状态（players: [{id,name}]）
 *   applyMove(state, playerId, move) -> { ok, error?, gameOver?, winnerId?, isDraw?, reason?, nextTurn? }
 *   serialize(state)  生成发给客户端的状态快照
 *   parseMove(raw)    校验并规范化 move
 */
import type { GameModule, GameTypeInfo } from '../types.js';
import * as xiangqi from './xiangqi.js';
import * as gomoku from './gomoku.js';

export const games: Record<string, GameModule> = {
  xiangqi: xiangqi as unknown as GameModule,
  gomoku: gomoku as unknown as GameModule,
};

export function getGame(type: string | undefined | null): GameModule | null {
  if (!type) return null;
  return games[type] || null;
}

export function isValidGameType(type: unknown): type is string {
  return typeof type === 'string' && !!games[type];
}

export function listGameTypes(): GameTypeInfo[] {
  return Object.keys(games).map((t) => ({
    type: t,
    name: games[t].name,
    minPlayers: games[t].minPlayers,
    maxPlayers: games[t].maxPlayers,
    supportsSpectate: games[t].supportsSpectate,
  }));
}
