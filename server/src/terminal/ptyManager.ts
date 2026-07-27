import * as pty from "node-pty";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import { suppressSocketErrors } from "../wsSafety";
import { TMUX_SESSION_NAME, PROJECT_DIR } from "../config";
import {
  TERMINAL_CLOSE_CODES,
  isValidTerminalId,
  type TerminalClientMessage,
} from "remote-console-shared";

const TMUX_CONF_PATH = path.resolve(__dirname, "../../tmux.conf");

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function tmuxSessionName(id: string): string {
  return `${TMUX_SESSION_NAME}-${id}`;
}

function spawnTerminal(id: string): pty.IPty {
  return pty.spawn(
    "tmux",
    [
      "-f",
      TMUX_CONF_PATH,
      "new-session",
      "-A",
      "-s",
      tmuxSessionName(id),
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

// idごとに独立したセッションのため、後勝ち判定もid単位のMapで管理する
const activeConnections = new Map<string, { ws: WebSocket; ptyProcess: pty.IPty }>();

export function registerTerminalWebSocket(wss: WebSocketServer): void {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    suppressSocketErrors(ws);

    const { pathname } = new URL(req.url ?? "", "http://localhost");
    const match = pathname.match(/^\/ws\/terminal\/(.+)$/);
    const id = match?.[1];
    if (!id || !isValidTerminalId(id)) {
      ws.close(TERMINAL_CLOSE_CODES.invalid_id, "invalid_id");
      return;
    }

    const existing = activeConnections.get(id);
    if (existing) {
      console.log(
        `[ptyManager] terminal ${id}: new connection supersedes existing one`,
      );
      existing.ws.close(TERMINAL_CLOSE_CODES.superseded, "superseded");
    }

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = spawnTerminal(id);
    } catch (err) {
      console.error(`[ptyManager] terminal ${id}: failed to spawn tmux:`, err);
      ws.close(TERMINAL_CLOSE_CODES.spawn_failed, "spawn_failed");
      return;
    }
    activeConnections.set(id, { ws, ptyProcess });
    console.log(`[ptyManager] terminal ${id}: connected (pid=${ptyProcess.pid})`);

    let exited = false;

    ptyProcess.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      exited = true;
      console.log(
        `[ptyManager] terminal ${id}: tmux client exited (pid=${ptyProcess.pid}, code=${exitCode}, signal=${signal})`,
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
      console.log(
        `[ptyManager] terminal ${id}: disconnected (pid=${ptyProcess.pid})`,
      );
      if (!exited) {
        try {
          ptyProcess.kill();
        } catch {
          // 既に終了済みのプロセスへのkillはESRCH等で例外になりうるため無視する
        }
      }
      if (activeConnections.get(id)?.ws === ws) {
        activeConnections.delete(id);
      }
    });
  });
}

// SIGTERM等でのgraceful shutdown用。tmuxサーバー自体・その中のシェルは影響を受けず残る
export function shutdownTerminal(): void {
  for (const [id, conn] of activeConnections) {
    console.log(
      `[ptyManager] terminal ${id}: shutting down (pid=${conn.ptyProcess.pid})`,
    );
    try {
      conn.ptyProcess.kill();
    } catch {
      // 既に終了済みのプロセスへのkillはESRCH等で例外になりうるため無視する
    }
    conn.ws.close(TERMINAL_CLOSE_CODES.server_shutdown, "server_shutdown");
  }
  activeConnections.clear();
}
