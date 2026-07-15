import * as pty from 'node-pty';
import path from 'node:path';
import type { WebSocket, WebSocketServer } from 'ws';

const TMUX_CONF_PATH = path.resolve(__dirname, '../../tmux.conf');

const TMUX_SESSION_NAME = process.env.TMUX_SESSION_NAME;
if (!TMUX_SESSION_NAME) {
  throw new Error('TMUX_SESSION_NAME is not set. Check .env');
}

const PROJECT_DIR = process.env.PROJECT_DIR;
if (!PROJECT_DIR) {
  throw new Error('PROJECT_DIR is not set. Check .env');
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function spawnTerminal(): pty.IPty {
  return pty.spawn(
    'tmux',
    ['-f', TMUX_CONF_PATH, 'new-session', '-A', '-s', TMUX_SESSION_NAME as string, '-c', PROJECT_DIR as string],
    {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: PROJECT_DIR,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    },
  );
}

// 有効な接続は1つのみ(CLAUDE.md Step 3の同時接続ポリシー)。
let current: { ws: WebSocket; ptyProcess: pty.IPty } | null = null;

export function registerTerminalWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws) => {
    // モバイル回線切断等で'error'が発生し得る。リスナーが無いとNodeプロセスごと落ちるため必須。
    ws.on('error', () => {});

    if (current) {
      current.ws.close(4000, 'superseded');
    }

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = spawnTerminal();
    } catch {
      ws.close(4001, 'spawn_failed');
      return;
    }
    current = { ws, ptyProcess };

    let exited = false;

    ptyProcess.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    });

    ptyProcess.onExit(() => {
      exited = true;
      ws.close();
    });

    ws.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) return;
      const { type } = msg as Record<string, unknown>;

      if (type === 'input') {
        const { data } = msg as Record<string, unknown>;
        if (typeof data === 'string') {
          ptyProcess.write(data);
        }
        return;
      }

      if (type === 'resize') {
        const { cols, rows } = msg as Record<string, unknown>;
        if (typeof cols === 'number' && typeof rows === 'number' && cols > 0 && rows > 0) {
          ptyProcess.resize(cols, rows);
        }
      }
    });

    ws.on('close', () => {
      if (!exited) {
        try {
          ptyProcess.kill();
        } catch {
          // 既に終了済みのプロセスへのkill()はESRCH等でthrowすることがある。
        }
      }
      if (current?.ws === ws) {
        current = null;
      }
    });
  });
}
