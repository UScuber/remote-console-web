import { execFile } from "node:child_process";
import type { Request, Response } from "express";
import { isValidTerminalId } from "remote-console-shared";
import { TMUX_SESSION_NAME } from "../config";

const MAX_HISTORY_LINES = 5000;
const CAPTURE_MAX_BUFFER = 16 * 1024 * 1024;

// 簡易的なCSI検知、ライブラリを使わず空行判定にだけ使う
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function isBlankLine(line: string): boolean {
  return line.replace(ANSI_ESCAPE_RE, "").trim().length === 0;
}

// capture-paneはペイン高さ分を空行で埋めて返すため、末尾だけ除去して実データに合わせる
function trimTrailingBlankLines(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && isBlankLine(lines[end - 1])) {
    end--;
  }
  return lines.slice(0, end).join("\n");
}

export function terminalHistoryHandler(req: Request, res: Response): void {
  const id = req.params.id;
  if (typeof id !== "string" || !isValidTerminalId(id)) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }
  const args = [
    "capture-pane",
    "-pe", // -e: ANSIエスケープ付きで出力しクライアント側で端末と同じ配色に復元する
    "-t",
    `${TMUX_SESSION_NAME}-${id}`,
    "-S",
    `-${MAX_HISTORY_LINES}`,
  ];
  execFile("tmux", args, { maxBuffer: CAPTURE_MAX_BUFFER }, (err, stdout) => {
    if (err) {
      res.status(503).json({ error: "capture_failed" }); // tmuxセッション未起動など
      return;
    }
    res.type("text/plain; charset=utf-8").send(trimTrailingBlankLines(stdout));
  });
}
