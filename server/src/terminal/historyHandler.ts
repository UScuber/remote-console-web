import { execFile } from 'node:child_process';
import type { Request, Response } from 'express';

const TMUX_SESSION_NAME = process.env.TMUX_SESSION_NAME;
if (!TMUX_SESSION_NAME) {
  throw new Error('TMUX_SESSION_NAME is not set. Check .env');
}

// テキスト表示に取り込むスクロールバックの上限行数(肥大対策。足りなければ調整)。
const MAX_HISTORY_LINES = 5000;
const CAPTURE_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * 「テキスト表示」モード用に、tmuxのスクロールバックを色付き(ANSIエスケープ込み, -e)で返す。
 * canvas描画のxtermでは効かないモバイルの文字選択・コピーの代替(CLAUDE.md Step 4参照)。
 */
export function terminalHistoryHandler(_req: Request, res: Response): void {
  const args = ['capture-pane', '-pe', '-t', TMUX_SESSION_NAME as string, '-S', `-${MAX_HISTORY_LINES}`];
  execFile('tmux', args, { maxBuffer: CAPTURE_MAX_BUFFER }, (err, stdout) => {
    if (err) {
      res.status(503).json({ error: 'capture_failed' }); // セッション未起動など
      return;
    }
    res.type('text/plain; charset=utf-8').send(stdout);
  });
}
