import * as pty from "node-pty";
import path from "node:path";
import type { WebSocket, WebSocketServer } from "ws";
import { suppressSocketErrors } from "../wsSafety";
import { TMUX_SESSION_NAME, PROJECT_DIR } from "../config";
import {
  TERMINAL_CLOSE_CODES,
  type TerminalClientMessage,
} from "remote-console-shared";

const TMUX_CONF_PATH = path.resolve(__dirname, "../../tmux.conf");

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function spawnTerminal(): pty.IPty {
  return pty.spawn(
    "tmux",
    [
      "-f",
      TMUX_CONF_PATH,
      "new-session",
      "-A",
      "-s",
      TMUX_SESSION_NAME,
      "-c",
      PROJECT_DIR,
    ],
    {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: PROJECT_DIR,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    },
  );
}

// tmuxセッションは共有のため、後勝ちで置き換えても新接続は同じ作業画面に復帰する
let activeConnection: { ws: WebSocket; ptyProcess: pty.IPty } | null = null;

export function registerTerminalWebSocket(wss: WebSocketServer): void {
  wss.on("connection", (ws) => {
    suppressSocketErrors(ws);

    if (activeConnection) {
      console.log("[ptyManager] new connection supersedes existing one");
      activeConnection.ws.close(TERMINAL_CLOSE_CODES.superseded, "superseded");
    }

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = spawnTerminal();
    } catch (err) {
      console.error("[ptyManager] failed to spawn tmux:", err);
      ws.close(TERMINAL_CLOSE_CODES.spawn_failed, "spawn_failed");
      return;
    }
    activeConnection = { ws, ptyProcess };
    console.log(`[ptyManager] terminal connected (pid=${ptyProcess.pid})`);

    let exited = false;

    ptyProcess.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      exited = true;
      console.log(
        `[ptyManager] tmux client exited (pid=${ptyProcess.pid}, code=${exitCode}, signal=${signal})`,
      );
      ws.close();
    });

    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null) return;
      const { type } = msg as Partial<TerminalClientMessage>;

      if (type === "input") {
        const { data } = msg as Record<string, unknown>;
        if (typeof data === "string") {
          ptyProcess.write(data);
        }
        return;
      }

      if (type === "resize") {
        const { cols, rows } = msg as Record<string, unknown>;
        if (
          typeof cols === "number" &&
          typeof rows === "number" &&
          cols > 0 &&
          rows > 0
        ) {
          ptyProcess.resize(cols, rows);
        }
      }
    });

    ws.on("close", () => {
      console.log(`[ptyManager] terminal disconnected (pid=${ptyProcess.pid})`);
      if (!exited) {
        try {
          ptyProcess.kill();
        } catch {
          // 既に終了済みのプロセスへのkillはESRCH等で例外になりうるため無視する
        }
      }
      if (activeConnection?.ws === ws) {
        activeConnection = null;
      }
    });
  });
}

// SIGTERM等でのgraceful shutdown用。tmuxサーバー自体・その中のシェルは影響を受けず残る
export function shutdownTerminal(): void {
  if (!activeConnection) return;
  console.log(`[ptyManager] shutting down (pid=${activeConnection.ptyProcess.pid})`);
  try {
    activeConnection.ptyProcess.kill();
  } catch {
    // 既に終了済みのプロセスへのkillはESRCH等で例外になりうるため無視する
  }
  activeConnection.ws.close(TERMINAL_CLOSE_CODES.server_shutdown, "server_shutdown");
  activeConnection = null;
}
