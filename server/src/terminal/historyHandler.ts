import { execFile } from "node:child_process";
import type { Request, Response } from "express";
import { TMUX_SESSION_NAME } from "../config";

const MAX_HISTORY_LINES = 5000;
const CAPTURE_MAX_BUFFER = 16 * 1024 * 1024;

export function terminalHistoryHandler(_req: Request, res: Response): void {
  const args = [
    "capture-pane",
    "-pe", // -e: ANSIエスケープ付きで出力しクライアント側で端末と同じ配色に復元する
    "-t",
    TMUX_SESSION_NAME,
    "-S",
    `-${MAX_HISTORY_LINES}`,
  ];
  execFile("tmux", args, { maxBuffer: CAPTURE_MAX_BUFFER }, (err, stdout) => {
    if (err) {
      res.status(503).json({ error: "capture_failed" }); // tmuxセッション未起動など
      return;
    }
    res.type("text/plain; charset=utf-8").send(stdout);
  });
}
