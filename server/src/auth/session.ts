import session from "express-session";
import createMemoryStore from "memorystore";
import { SESSION_SECRET } from "../config";

declare module "express-session" {
  interface SessionData {
    authenticated?: boolean;
  }
}

export const SESSION_COOKIE_NAME = "sessionId";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MemoryStore = createMemoryStore(session);

// WebSocketアップグレード要求からもCookie検証に使うため個別にexportする(middleware.ts参照)
export const sessionStore = new MemoryStore({ checkPeriod: 24 * 60 * 60 * 1000 });

export const sessionMiddleware = session({
  name: SESSION_COOKIE_NAME,
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: {
    httpOnly: true,
    // 固定trueだとローカルのhttp検証でCookieが保存されないため接続方式で自動判定させる
    secure: "auto",
    sameSite: "strict",
    maxAge: SESSION_TTL_MS,
  },
});

// IPで区別せずグローバルにカウントする(理由はserver/README.md参照)
const MAX_CONSECUTIVE_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000;

let consecutiveFailures = 0;
let lockedUntil = 0;

export function getLoginLockRemainingMs(): number {
  const remaining = lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

export function recordLoginFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    lockedUntil = Date.now() + LOCKOUT_MS;
    consecutiveFailures = 0;
  }
}

export function recordLoginSuccess(): void {
  consecutiveFailures = 0;
  lockedUntil = 0;
}
