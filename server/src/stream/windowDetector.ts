import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { WebSocket, WebSocketServer } from 'ws';

export interface WindowInfo {
  id: string;
  title: string;
}

// wmctrl -l のポーリング間隔
const POLL_INTERVAL_MS = 2000;

// タイトルにこの部分文字列を含むウィンドウは一覧から除外する(このWebアプリ自身のブラウザウィンドウ等)。
// カンマ区切りで複数指定可能。
const EXCLUDE_TITLE_SUBSTRINGS = (process.env.WINDOW_TITLE_EXCLUDE ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const emitter = new EventEmitter();
let current: WindowInfo[] = [];
// 起動直後のwmctrl失敗(Xセッション確立前)でログを埋めないよう、状態遷移時のみ1回だけ出す。
let consecutiveFailures = 0;

function parseWmctrlOutput(stdout: string): WindowInfo[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      // 「ウィンドウID デスクトップ番号 ホスト名 タイトル...」。タイトル自体に空白を含みうるため先頭3フィールドのみ分割する。
      const parts = line.split(/\s+/);
      const id = parts[0] ?? '';
      const title = parts.slice(3).join(' ');
      return { id, title };
    })
    .filter((w) => w.id.length > 0)
    .filter((w) => !EXCLUDE_TITLE_SUBSTRINGS.some((sub) => w.title.includes(sub)));
}

function sameList(a: WindowInfo[], b: WindowInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((w, i) => w.id === b[i].id && w.title === b[i].title);
}

function poll(): void {
  execFile('wmctrl', ['-l'], (err, stdout) => {
    if (err) {
      consecutiveFailures += 1;
      if (consecutiveFailures === 1) {
        console.debug('[windowDetector] wmctrl -l failed (will keep retrying):', err.message);
      }
      return;
    }
    if (consecutiveFailures > 0) {
      console.debug('[windowDetector] wmctrl -l recovered');
    }
    consecutiveFailures = 0;

    const next = parseWmctrlOutput(stdout);
    if (!sameList(current, next)) {
      current = next;
      emitter.emit('change', current);
    }
  });
}

let started = false;

export function startWindowDetector(): void {
  if (started) return;
  started = true;
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

export function getCurrentWindows(): WindowInfo[] {
  return current;
}

// windowIdが現在の一覧に存在しなくなった(ウィンドウが閉じられた)ことをffmpegStream側が検知するために使う。
export function onWindowsChange(listener: (windows: WindowInfo[]) => void): () => void {
  emitter.on('change', listener);
  return () => emitter.off('change', listener);
}

export function registerWindowsWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket) => {
    // モバイル回線切断等で'error'が発生し得る。リスナーが無いとNodeプロセスごと落ちるため必須。
    ws.on('error', () => {});

    ws.send(JSON.stringify({ type: 'windows', windows: current }));

    const unsubscribe = onWindowsChange((windows) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'windows', windows }));
      }
    });

    ws.on('close', () => {
      unsubscribe();
    });
  });
}
