import "./loadEnv";
import path from "node:path";
import { createServer } from "node:http";
import express from "express";
import bcrypt from "bcrypt";
import { WebSocketServer } from "ws";
import { PORT, LOGIN_PASSWORD_HASH, IS_PRODUCTION } from "./config";
import {
  requireAuth,
  csrfProtection,
  generateCsrfToken,
  loginRateLimiter,
  isRequestAuthenticated,
} from "./auth/middleware";
import {
  sessionMiddleware,
  recordLoginFailure,
  recordLoginSuccess,
  SESSION_COOKIE_NAME,
} from "./auth/session";
import { registerTerminalWebSocket, shutdownTerminal } from "./terminal/ptyManager";
import { terminalHistoryHandler } from "./terminal/historyHandler";
import {
  registerWindowsWebSocket,
  startWindowDetector,
} from "./stream/windowDetector";
import {
  registerWindowStreamWebSocket,
  shutdownStreams,
  MAX_ACTIVE_STREAMS,
} from "./stream/ffmpegStream";
import { getSleepGuardEnabled, setSleepGuardEnabled } from "./display/sleepGuard";
import { enableHeartbeat } from "./wsHeartbeat";

const app = express();
app.use(express.json());

// Tailscale ServeはX-Forwarded-Protoを付与しないため、本番でのみSecure Cookie判定用に自前で補う
if (IS_PRODUCTION) {
  app.use((req, _res, next) => {
    req.headers["x-forwarded-proto"] = "https";
    next();
  });
}
app.use(sessionMiddleware);

app.get("/api/session", (req, res) => {
  // 未認証でもgenerateCsrfTokenがreq.sessionへ書き込むため、匿名アクセスだけでもMemoryStoreに
  // セッションが1件保存される(saveUninitialized:falseは新規書き込みには効かない)。Tailnet内
  // 単一ユーザー運用のため実害はないと判断し許容している(レビュー指摘C-5、詳細はserver/README.md)
  const csrfToken = generateCsrfToken(req);
  res.json({
    authenticated: Boolean(req.session.authenticated),
    csrfToken,
    maxActiveStreams: MAX_ACTIVE_STREAMS,
  });
});

// 参照のみのGETなのでCSRF保護は不要
app.get("/api/terminal/history", requireAuth, terminalHistoryHandler);

// 参照のみのGETなのでCSRF保護は不要
app.get("/api/display/sleep-guard", requireAuth, (_req, res) => {
  res.json({ enabled: getSleepGuardEnabled() });
});

app.post(
  "/api/display/sleep-guard",
  csrfProtection,
  requireAuth,
  async (req, res) => {
    const nextEnabled = req.body?.enabled;
    if (typeof nextEnabled !== "boolean") {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    try {
      await setSleepGuardEnabled(nextEnabled);
      res.json({ enabled: getSleepGuardEnabled() });
    } catch (err) {
      console.error("[index] sleep-guard xset failed:", (err as Error).message);
      res.status(500).json({ error: "xset_failed" });
    }
  },
);

app.post("/api/login", loginRateLimiter, csrfProtection, async (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const ok =
    password.length > 0 && (await bcrypt.compare(password, LOGIN_PASSWORD_HASH));
  if (!ok) {
    recordLoginFailure();
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  recordLoginSuccess();
  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: "session_error" });
      return;
    }
    req.session.authenticated = true;
    // regenerate()で旧セッションのCSRFトークンが失われるため新セッション用に発行し直す
    const csrfToken = generateCsrfToken(req, true);
    res.json({ ok: true, csrfToken });
  });
});

app.post("/api/logout", csrfProtection, requireAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: "session_error" });
      return;
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    res.json({ ok: true });
  });
});

// APIルートを先に固めた後、'/'はexpress.staticがindex.htmlを自動応答する
const CLIENT_DIST_DIR = path.resolve(__dirname, "../../client/dist");
app.use(express.static(CLIENT_DIST_DIR));

// エラー発生時もJSONで返す(デフォルトのHTMLエラーページだとクライアントでres.json()が失敗する)
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status =
      typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : 500;
    const code =
      typeof (err as { code?: unknown })?.code === "string"
        ? (err as { code: string }).code
        : "internal_error";
    res.status(status).json({ error: code });
  },
);

const server = createServer(app);

const terminalWss = new WebSocketServer({ noServer: true });
registerTerminalWebSocket(terminalWss);
enableHeartbeat(terminalWss);

const windowsWss = new WebSocketServer({ noServer: true });
registerWindowsWebSocket(windowsWss);
enableHeartbeat(windowsWss);

const windowStreamWss = new WebSocketServer({ noServer: true });
registerWindowStreamWebSocket(windowStreamWss);
enableHeartbeat(windowStreamWss);

startWindowDetector();

function resolveWss(pathname: string): WebSocketServer | undefined {
  if (pathname === "/ws/terminal") return terminalWss;
  if (pathname === "/ws/windows") return windowsWss;
  if (pathname.startsWith("/ws/window/")) return windowStreamWss;
  return undefined;
}

function onSocketError(err: Error): void {
  // isRequestAuthenticated()解決前にクライアントが切断すると、リスナー無しのsocketは
  // 未捕捉例外でプロセスごと落ちる。ws公式サンプルに倣いupgrade直後から'error'を張る
  console.debug("[index] upgrade socket error:", err.message);
}

server.on("upgrade", (req, socket, head) => {
  socket.on("error", onSocketError);

  const { pathname } = new URL(req.url ?? "", "http://localhost");
  const wss = resolveWss(pathname);

  if (!wss) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  isRequestAuthenticated(req)
    .then((authenticated) => {
      if (!authenticated) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        socket.removeListener("error", onSocketError);
        wss.emit("connection", ws, req);
      });
    })
    .catch(() => {
      socket.destroy();
    });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`server listening on http://127.0.0.1:${PORT}`);
});

// systemd等からのSIGTERM/SIGINTでffmpeg・ptyの子プロセスを明示的に終了させてから終了する
// (パイプ切断で実質的には死ぬはずだが、明示終了の方が終了タイミングに依存しない)
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[index] received ${signal}, shutting down`);
  shutdownTerminal();
  shutdownStreams();
  server.close(() => process.exit(0));
  // closeがコールバックされない場合(ソケット滞留等)でも確実に終了する
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
