/**
 * eleeye（象眼）UCCI 引擎客户端
 *
 * 通过 UCCI 协议驱动 engines/eleeye.exe 计算中国象棋走法。
 * - 走法格式：4 字符 "<列字母 a-i><行数字 0-9><列字母 a-i><行数字 0-9>"，与内部坐标 (x,y) 直接对应
 * - FEN 生成：红方大写（K 帅 A 仕 B 相 N 马 R 车 C 炮 P 兵），黑方小写
 * - 单例复用引擎进程；失败时由调用方回退到内置 AI
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../log/logger.js';
import type { Coord, Move } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = path.resolve(__dirname, '../../engines/eleeye.exe');

/**
 * eleeye 的 UCCI 约定（已由源码 + 实验确认）：
 * - FEN：黑方在顶部（小写字母）、红方在底部（大写字母），与内部坐标（黑 y=0 顶、红 y=9 底）一致，无需行反转
 * - side 标记：'w' = 红方走，'b' = 黑方走（标准语义）
 * - 引擎输出的走法坐标统一为红方视角（rank 0 = 红方底线），与内部坐标上下颠倒，需 y 反转
 */
const FEN_MAP = {
  rk: 'K', ra: 'A', re: 'B', rh: 'N', rr: 'R', rc: 'C', rp: 'P',
  bk: 'k', ba: 'a', be: 'b', bh: 'n', br: 'r', bc: 'c', bp: 'p',
};

/** 内部坐标 -> UCCI 走法（4 字符，红方视角 y 反转） */
export function toUcciMove(from: Coord, to: Coord): string {
  const file = (x: number) => 'abcdefghi'[x];
  return `${file(from.x)}${9 - from.y}${file(to.x)}${9 - to.y}`;
}

/** UCCI 走法 -> 内部坐标（y 反转回内部视角） */
export function fromUcciMove(mv: string): Move | null {
  if (!/^[a-i][0-9][a-i][0-9]$/.test(mv)) return null;
  const f = (ch: string) => 'abcdefghi'.indexOf(ch);
  return {
    from: { x: f(mv[0]), y: 9 - Number(mv[1]) },
    to: { x: f(mv[2]), y: 9 - Number(mv[3]) },
  };
}

/**
 * 棋盘（9x10 编码数组）-> 中国象棋 FEN（eleeye 惯例：黑顶红底、红大写黑小写）
 * @param board 棋盘
 * @param side 当前走棋方 'r'=红 / 'b'=黑（内部颜色）
 */
export function boardToFen(board: (string | null)[][], side: string = 'r'): string {
  const rows: string[] = [];
  for (let y = 0; y < 10; y++) {
    let row = '';
    let empty = 0;
    for (let x = 0; x < 9; x++) {
      const code = board[y][x];
      if (code) {
        if (empty > 0) { row += empty; empty = 0; }
        row += (FEN_MAP as Record<string, string>)[code] ?? '?';
      } else {
        empty++;
      }
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }
  // eleeye：'w' = 红方走，'b' = 黑方走
  const fenSide = side === 'b' ? 'b' : 'w';
  return `${rows.join('/')} ${fenSide} - - 0 1`;
}

interface EngineWaiter {
  contains: string;
  resolve: (line: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class UcciEngine {
  proc: ChildProcess | null;
  ready: boolean;
  buffer: string;
  waiters: EngineWaiter[];
  busy: boolean;

  constructor() {
    this.proc = null;
    this.ready = false;
    this.buffer = '';
    this.waiters = [];
    this.busy = false;
  }

  /** 启动引擎进程（幂等） */
  async ensureStarted() {
    if (this.proc && !this.proc.killed) return;
    await new Promise<void>((resolve, reject) => {
      this.proc = spawn(ENGINE_PATH, [], { stdio: ['pipe', 'pipe', 'inherit'] });
      this.buffer = '';
      this.waiters = [];
      this.ready = false;
      this.proc.stdout!.setEncoding('utf8');
      this.proc.stdout!.on('data', (d: string) => this._onData(d));
      this.proc.on('error', (err: Error) => {
        logger.error('engine', 'eleeye 启动失败', { error: err.message });
        reject(err);
      });
      this.proc.on('exit', (code: number | null) => {
        logger.warn('engine', 'eleeye 进程退出', { code });
        this.proc = null;
        this.ready = false;
        // 唤醒所有等待者（失败）
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(new Error('引擎进程退出'));
        }
      });
      this._onData = this._onData.bind(this);
      this._waitFor('ucciok', 10000).then(() => {
        this.ready = true;
        this.send('setoption usemillisec true');
        resolve();
      }).catch(reject);
      this.send('ucci');
    });
  }

  _onData(d: string): void {
    this.buffer += d;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        if (l.includes(w.contains)) {
          this.waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(l);
          break;
        }
      }
    }
  }

  send(cmd: string): void {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(cmd + '\n');
    }
  }

  _waitFor(contains: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const w: EngineWaiter = {
        contains,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`等待引擎 "${contains}" 超时`));
        }, timeout),
      };
      this.waiters.push(w);
    });
  }

  /**
   * 计算最佳走法（基于当前局面 FEN）
   * @param board 当前棋盘（9x10 编码数组）
   * @param side 当前走棋方 'r' | 'b'（FEN 侧标记）
   * @param timeMs 思考时间（毫秒）
   * @returns { from, to } | null
   */
  async getBestMove(board: (string | null)[][], side: string = 'b', timeMs = 1500): Promise<Move | null> {
    await this.ensureStarted();
    if (!this.ready) return null;
    if (this.busy) return null; // 串行保护

    const fen = boardToFen(board, side);
    this.send(`position fen ${fen}`);
    this.send(`go time ${timeMs}`);

    this.busy = true;
    try {
      const line = await this._waitFor('bestmove', timeMs + 15000);
      const mv = line.split(' ')[1];
      if (!mv || mv === '(none)') return null;
      return fromUcciMove(mv);
    } catch (err) {
      logger.warn('engine', '引擎计算失败', { error: (err as Error).message });
      return null;
    } finally {
      this.busy = false;
    }
  }

  async close() {
    try {
      this.send('quit');
      await new Promise((r) => setTimeout(r, 200));
      this.proc?.kill();
    } catch { /* 忽略 */ }
    this.proc = null;
    this.ready = false;
  }
}

export const ucciEngine = new UcciEngine();
export const ELEEYE_PATH = ENGINE_PATH;
