import session from 'express-session';
import createMemoryStore from 'memorystore';

declare module 'express-session' {
  interface SessionData {
    authenticated?: boolean;
  }
}

export const SESSION_COOKIE_NAME = 'sessionId';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const rawSessionSecret = process.env.SESSION_SECRET;
if (!rawSessionSecret) {
  throw new Error('SESSION_SECRET is not set. Check .env');
}
export const sessionSecret: string = rawSessionSecret;

const MemoryStore = createMemoryStore(session);

// WebSocketアップグレード要求(Step 3以降)からもCookie署名検証・セッション照会に使うため、
// ストアをexpress-sessionミドルウェアとは別に名前を付けて公開しておく。
export const sessionStore = new MemoryStore({ checkPeriod: 24 * 60 * 60 * 1000 });

// セッションの発行・検証・失効はexpress-session(+期限切れを自動掃除するmemorystore)に委譲する。
// rolling: true により、アクセスのたびに有効期限がスライディングで延長される。
export const sessionMiddleware = session({
  name: SESSION_COOKIE_NAME,
  secret: sessionSecret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: {
    httpOnly: true,
    // HTTPS接続の時だけSecure属性を付ける(固定trueだとローカルのhttp検証でCookieが保存されない)
    secure: 'auto',
    sameSite: 'strict',
    maxAge: SESSION_TTL_MS,
  },
});

// ブルートフォース対策。Tailscale Serve経由では接続元IPが常に127.0.0.1に見えるため、
// IP単位ではなくグローバルカウンタとする(利用者1人の前提)。
const MAX_CONSECUTIVE_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000;

let consecutiveFailures = 0;
let lockedUntil = 0;

// ロック中なら残りミリ秒を返す。ロックされていなければ0。
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
