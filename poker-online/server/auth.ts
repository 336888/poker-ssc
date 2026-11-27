// 鉴权：玩家令牌（HMAC 签名，无需存储）、后台登录会话、登录失败锁定

import { createHmac, randomBytes, scryptSync, scrypt, timingSafeEqual } from 'node:crypto';

export class PlayerTokens {
  constructor(private secret: string) {}

  sign(code: string, playerId: string): string {
    return createHmac('sha256', this.secret).update(`${code}:${playerId}`).digest('base64url');
  }

  verify(code: string, playerId: string, token: string): boolean {
    const expected = Buffer.from(this.sign(code, playerId));
    const got = Buffer.from(token);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }
}

const SESSION_MS = 2 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;

export function hashAdminPassword(password:string): string {
  const salt=randomBytes(16).toString('hex');
  return salt+':'+scryptSync(password,salt,64).toString('hex');
}

export class AdminAuth {
  private pending = 0;
  private sessions = new Map<string, number>();
  private fails = new Map<string, { count: number; until: number }>();

  constructor(private verifier: string) {}

  /** 返回会话令牌；失败时抛出带提示的错误 */
  async login(ip: string, password: unknown): Promise<string> {
    const now = Date.now();
    const f = this.fails.get(ip) ?? { count: 0, until: 0 };
    if (f.until > now) throw new AuthError(429, `尝试次数过多，请 ${Math.ceil((f.until - now) / 1000)} 秒后再试`);
    if(!this.verifier)throw new AuthError(503,'请先配置后台登录密码');
    if(this.pending>=4)throw new AuthError(429,'请稍后重试');
    const [salt,digest]=this.verifier.split(':');
    this.pending++;
    let ok=false;
    try {
      const candidate=typeof password==='string' ? password : '';
      const key=await new Promise<Buffer>((resolve,reject)=>scrypt(candidate,salt,64,(error,value)=>error?reject(error):resolve(value)));
      ok=timingSafeEqual(key,Buffer.from(digest,'hex'));
    }finally{this.pending--}
    if (!ok) {
      const count = (this.fails.get(ip)?.count ?? 0) + 1;
      this.fails.set(ip, count >= MAX_FAILS ? { count: 0, until: now + LOCK_MS } : { count, until: 0 });
      throw new AuthError(401, count >= MAX_FAILS ? '密码错误次数过多，已锁定 60 秒' : `密码错误（还可尝试 ${MAX_FAILS - count} 次）`);
    }
    this.fails.delete(ip);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, now + SESSION_MS);
    return token;
  }

  check(authHeader: string | undefined): boolean {
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (!exp || exp < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  logout(authHeader: string | undefined) {
    if (authHeader?.startsWith('Bearer ')) this.sessions.delete(authHeader.slice(7));
  }
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 简单的滑动窗口限流 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  /** 定期清理过期条目 */
  sweep() {
    const now = Date.now();
    for (const [k, list] of this.hits) if (!list.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}
