// HTTP + WebSocket 服务：REST 接口、实时对局、后台管理、静态前端

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { containsBlocked } from '../src/net/moderation';
import { normalizeCode } from '../src/net/inviteCode';
import type { ServerMessage } from '../src/net/protocol';
import { randomId } from '../src/net/roomServer';
import { AdminAuth, AuthError, hashAdminPassword, PlayerTokens, RateLimiter } from './auth';
import { Store } from './db';
import { log } from './log';
import { cardTables } from './cardTables.js';
import { rtCfg, useTargets, gameRate, botGames, type BotTargets } from './rtcfg';
import { RoomManager } from './rooms';
import { cleanName, parseClientMessage, sanitizeConfig } from './validate';

export interface AppOptions {
  port: number;
  host?: string;
  dbFile: string;
  /** 前端构建产物目录（dist），存在时一并托管 */
  staticDir?: string;
  adminPassword?: string;
  sessionSecret?: string;
  corsOrigin?: string;
  trustProxy?: boolean;
  maxRooms?: number;
  quiet?: boolean;
}

export interface App {
  server: Server;
  rooms: RoomManager;
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 16 * 1024;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export async function createApp(opts: AppOptions): Promise<App> {
  const store = new Store(opts.dbFile);
  void import('./results').then((m) => m.bindStore(store));

  // 密钥与后台密码：优先使用环境变量，否则首次启动时生成并保存到数据库
  const secret = opts.sessionSecret || store.getMeta('session_secret') || randomBytes(32).toString('hex');
  if (!opts.sessionSecret) store.setMeta('session_secret', secret);
  const legacyPassword=store.getMeta('admin_password');
  let verifier=store.getMeta('admin_password_hash') || '';
  if(legacyPassword){
    if(!verifier){
      verifier=hashAdminPassword(legacyPassword);
      store.setMeta('admin_password_hash',verifier);
    }
    store.clearLegacyAdminPassword();
  }
  if(opts.adminPassword)verifier=hashAdminPassword(opts.adminPassword);
  const tokens = new PlayerTokens(secret);
  const admin = new AdminAuth(verifier);
  const rooms = new RoomManager(store, opts.maxRooms ?? 500);
  const walletPath = process.env.CARD_WALLET_DB || '/opt/ssc-ops/ssc_ops.db';
  const draining = () => existsSync(join(dirname(opts.dbFile), 'pause-matchmaking'));
  const admit = () => { if (draining()) throw new HttpError(503, '暂停新匹配，维护结束后可重新入场'); };
  const readTargets=():BotTargets=>JSON.parse(store.getMeta('bot_targets')||'{}');
  useTargets(readTargets());
  const duels = cardTables(walletPath,game=>({...rtCfg(),botRate:gameRate(game)}));
  if(existsSync(walletPath)){
    try{duels.resume()}catch(e){log('双人牌桌钱包未就绪',String(e))}
  }
  const duelTimer = setInterval(()=>{
    try{duels.tick()}catch(e){log('双人牌桌维护失败',String(e))}
  },1000);
  const createLimiter = new RateLimiter(10, 60 * 1000);
  const joinLimiter = new RateLimiter(30, 60 * 1000);
  const sweep = setInterval(() => {
    createLimiter.sweep();
    joinLimiter.sweep();
  }, 60 * 1000);

  const staticDir = opts.staticDir && existsSync(join(opts.staticDir, 'index.html')) ? resolve(opts.staticDir) : null;
  if (!opts.quiet) log(staticDir ? `托管前端：${staticDir}` : '未找到前端构建产物，仅提供 API');

  const ipOf = (req: IncomingMessage) => {
    const fwd = opts.trustProxy ? (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() : undefined;
    return fwd || req.socket.remoteAddress || 'unknown';
  };

  // ---------------------------------------------------------------- HTTP

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(data);
  };

  const readJson = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((ok, fail) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          fail(new HttpError(413, '请求体过大'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return ok({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          ok(v && typeof v === 'object' ? v : {});
        } catch {
          fail(new HttpError(400, '请求格式错误'));
        }
      });
      req.on('error', fail);
    });

  const requireAdmin = (req: IncomingMessage) => {
    if (!admin.check(req.headers.authorization)) throw new HttpError(401, '未登录或登录已过期');
  };

  function walletIdentity(req: IncomingMessage, expected?: unknown) {
    const auth = String(req.headers.authorization || '');
    if (!expected && !auth) return '';
    const [uid, expiry, signature] = auth.replace(/^Bearer /, '').split('.');
    if (!uid || !/^\d+$/.test(expiry || '') || Number(expiry) <= Date.now() ||
        !signature || !tokens.verify('duel-'+expiry,uid,signature) || (expected && expected !== uid))
      throw new HttpError(401,'请从主站重新进入棋牌大厅');
    return uid;
  }

  function currentWalletUser(req: IncomingMessage) {
    const uid=walletIdentity(req);
    if(!uid)throw new HttpError(401,'请从主站进入棋牌大厅');
    const requested=new URL(req.url || '/', 'http://local').searchParams.get('uid');
    if(requested!==null && requested!==uid)throw new HttpError(403,'无权访问该账户');
    return uid;
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? 'GET';
    const ip = ipOf(req);
    let m: RegExpMatchArray | null;

    if(method==='POST' && path==='/card-table'){
      const b=await readJson(req);
      const uid=walletIdentity(req);
      if(!uid) throw new HttpError(401,'请先登录');
      if(!existsSync(walletPath)) throw new HttpError(503,'棋牌钱包数据库未接入');
      try{return send(res,200,duels.request(uid,b,admit))}
      catch(e){if(e instanceof HttpError)throw e;const msg=(e as Error).message;
        if(/sqlite|database|SQLITE|table:|readonly/i.test(msg)){log('棋牌钱包异常',msg);throw new HttpError(503,'棋牌钱包暂不可用')}
        throw new HttpError(400,msg);
      }
    }
    // ---- 上一局结算结果（结算弹窗用）
    if (method === 'GET' && path === '/lastresult') {
      const u=currentWalletUser(req);
      res.setHeader('Cache-Control','private, no-store');
      const { getResult, getStreak } = await import('./results');
      const roundId = new URL(req.url || '/', 'http://local').searchParams.get('roundId');
      if (roundId !== null) {
        const record = store.historyById(roundId);
        const move = record?.walletMoves?.find(row => row.uid === u);
        if (!move || !record) return send(res, 200, {roundId, status: 'none'});
        if (record.walletStatus !== 'booked') return send(res, 200, {roundId, status: 'pending'});
        return send(res, 200, {roundId, status: 'booked', delta: move.delta, balance: move.balance, streak: getStreak(u)});
      }
      const r = getResult(u) ?? {};
      return send(res, 200, { ...r, streak: getStreak(u) });
    }

    // ---- 查询棋牌钱包余额（给前端显示自己用）
    if (method === 'GET' && path === '/me/balance') {
      const uid=currentWalletUser(req);
      res.setHeader('Cache-Control','private, no-store');
      try {
        const { getBalance } = await import('./settle');
        const r = await getBalance(uid);
        const raw = r?.balance;
        if ((typeof raw !== 'number' && !(typeof raw === 'string' && raw.trim())) || !Number.isFinite(Number(raw))) {
          throw new Error('invalid balance');
        }
        send(res, 200, { balance: Number(raw) });
      } catch {
        send(res, 503, { balance: null, error: '余额暂时无法刷新' });
      }
      return;
    }

    // ---- 主站单点登录
    if (method === 'POST' && path === '/sso') {
      const body = await readJson(req);
      const uid = String(body.uid || '').slice(0, 32);
      const ts = Number(body.ts || 0);
      const sig = String(body.sig || '');
      if (!uid || !ts || !sig) throw new HttpError(400, '参数缺失');
      if (!Number.isSafeInteger(ts) || ts > Math.floor(Date.now()/1000)+5 || Math.floor(Date.now()/1000)-ts > 60) throw new HttpError(401, '令牌已过期');
      const secret = process.env.POKER_SSO_SECRET || '';
      if (!secret) throw new HttpError(503, '单点登录未配置');
      const want = createHmac('sha256', secret).update(`${uid}:${ts}:0:`).digest('hex').slice(0, 32);
      if (want !== sig) throw new HttpError(401, '签名校验失败');
      // 余额校验：为 0 不允许进牌局
      try {
        const { getBalance } = await import('./settle');
        const b = await getBalance(uid);
        const bal = Number((b && (b as any).balance) || 0);
        const { rtCfg } = await import('./rtcfg');
        const minBal = rtCfg().minBal;
        if (bal < minBal) throw new HttpError(403, `余额不足 ${minBal} 元，请先充值`);
        const now=Math.floor(Date.now()/1000);
        if(now>ts+60 || !store.consumeSso(want,ts+60,now))throw new HttpError(401,'登录票据已使用或已过期');
        res.setHeader('Cache-Control','no-store');
        log('单点登录', uid, `余额${bal}`);
        const expiry=Date.now()+12*3600_000;
        const cardToken=uid+'.'+expiry+'.'+tokens.sign('duel-'+expiry,uid);
        return send(res, 200, { uid, name: uid, balance: bal, cardToken });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        log('余额查询失败', uid, (e as Error).message);
        throw new HttpError(503, '棋牌钱包暂不可用，请稍后重试');
      }
    }

    if (method === 'GET' && path === '/health') {
      const games = {doudizhu:{wait:0,play:0},paodekuai:{wait:0,play:0},zjh:{wait:0,play:0},nn:{wait:0,play:0}};
      for (const room of rooms.summaries()) games[room.mode][room.status === 'playing' ? 'play' : 'wait']++;
      if (existsSync(walletPath)) {
        for (const row of duels.activeCounts()) games[row.game][row.phase] = row.count;
      } else if (process.env.NODE_ENV === 'production') throw new HttpError(503, '无法核对五人牌桌');
      const total = Object.values(games).reduce((sum,g) => sum + g.wait + g.play, 0);
      return send(res, 200, {ok:true, rooms:total, games, draining:draining()});
    }

    if (method === 'POST' && path === '/rooms') {
      if (!createLimiter.allow(ip)) throw new HttpError(429, '创建房间太频繁，请稍后再试');
      const body = await readJson(req);
      admit();
      const name = cleanName(body.hostName);
      if (!name) throw new HttpError(400, '请输入昵称');
      const wantUid0 = walletIdentity(req,body.uid);
      if (!wantUid0 && containsBlocked(name)) throw new HttpError(400, '昵称包含不文明内容，请修改');
      const wantUid = wantUid0;
      let code: string;
      let hostId: string;
      try {
        ({ code, hostId } = rooms.create(wantUid ? wantUid : name, sanitizeConfig(body.config), wantUid, ip, typeof body.fp === 'string' ? body.fp.slice(0, 24) : ''));
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('同一设备') || msg.includes('房间已满')) throw new HttpError(400, msg);
        throw e;
      }
      if(wantUid) store.setMeta('wallet:'+code+':'+rooms.get(code)!.room.createdAt+':'+hostId,'1');
      return send(res, 200, { code, playerId: hostId, token: tokens.sign('room-v2:'+code, hostId) });
    }

    if (method === 'POST' && (m = path.match(/^\/rooms\/([A-Za-z0-9]{6})\/join$/))) {
      if (!joinLimiter.allow(ip)) throw new HttpError(429, '请求太频繁，请稍后再试');
      const code = normalizeCode(m[1]);
      const room = rooms.get(code);
      if (!room || room.closed) throw new HttpError(404, '房间不存在，请检查邀请码');
      const body = await readJson(req);
      admit();
      const name = cleanName(body.name);
      if (!name) throw new HttpError(400, '请输入昵称');
      const wantUidJ = walletIdentity(req,body.uid);
      if (!wantUidJ && containsBlocked(name)) throw new HttpError(400, '昵称包含不文明内容，请修改');
      if (room.room.status !== 'waiting') throw new HttpError(409, '游戏进行中，暂时无法加入');
      const playerId = wantUidJ || randomId('p');
      if(wantUidJ) store.setMeta('wallet:'+code+':'+room.room.createdAt+':'+playerId,'1');
      return send(res, 200, { playerId, token: tokens.sign('room-v2:'+code, playerId) });
    }

    // ---- 后台
    if (method === 'POST' && path === '/admin/login') {
      const body = await readJson(req);
      try {
        return send(res, 200, { token: await admin.login(ip, body.password) });
      } catch (e) {
        if (e instanceof AuthError) {
          log('后台登录失败', ip);
          throw new HttpError(e.status, e.message);
        }
        throw e;
      }
    }
    if (method === 'POST' && path === '/admin/logout') {
      admin.logout(req.headers.authorization);
      return send(res, 204);
    }
    if (path.startsWith('/admin/')) {
      requireAdmin(req);
      if(path==='/admin/bot-targets'){
        if(method==='GET')return send(res,200,{targets:readTargets(),fallback:Math.round(rtCfg().botRate*100)});
        if(method==='POST'){
          const input=await readJson(req);
          if(botGames.some(g=>!(g in input))||Object.keys(input).length!==botGames.length)
            throw new HttpError(400,'请提交完整的四款棋牌参数');
          const next:BotTargets={};
          for(const game of botGames){
            const value=input[game];
            if(value===null)continue;
            if(typeof value!=='number'||!Number.isInteger(value)||value<50||value>75)
              throw new HttpError(400,'目标值须为 50 至 75 的整数');
            next[game]=value;
          }
          store.setMeta('bot_targets',JSON.stringify(next));useTargets(next);
          return send(res,204);
        }
      }
      if (method === 'GET' && path === '/admin/rooms') return send(res, 200, rooms.summaries());
      if (method === 'DELETE' && (m = path.match(/^\/admin\/rooms\/([A-Z0-9]{6})$/))) {
        rooms.close(m[1]);
        return send(res, 204);
      }
      if (method === 'GET' && path === '/admin/history') return send(res, 200, store.listHistory(500));
      if (method === 'DELETE' && path === '/admin/history') {
        store.clearHistory();
        log('后台清空历史记录', ip);
        return send(res, 204);
      }
      if (method === 'DELETE' && (m = path.match(/^\/admin\/history\/(.+)$/))) {
        store.deleteHistory(decodeURIComponent(m[1]));
        return send(res, 204);
      }
    }

    throw new HttpError(404, '接口不存在');
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string) {
    // 原生后台已关闭：只允许从主站后台代理访问 /api/admin/*
    if (urlPath === '/admin' || urlPath.startsWith('/admin/')) {
      return send(res, 404, { error: 'Not found' });
    }
    if (!staticDir || (req.method !== 'GET' && req.method !== 'HEAD')) return send(res, 404, { error: 'Not found' });
    let file = resolve(staticDir, '.' + normalize(decodeURIComponent(urlPath)));
    if (!file.startsWith(staticDir + sep) && file !== staticDir) return send(res, 403, { error: 'Forbidden' });
    let isIndex = false;
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // 请求的是具体文件（带扩展名）但不存在：返回 404，避免把 HTML 当成 JS 缓存
      if (extname(urlPath)) return send(res, 404, { error: 'Not found' });
      // 单页应用：/admin 等前端路由都返回 index.html
      file = join(staticDir, 'index.html');
      isIndex = true;
    }
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': isIndex || ext === '.html' ? 'no-cache' : urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(readFileSync(file));
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (opts.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', opts.corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return send(res, 204);

    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname.slice(4));
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      log('请求处理异常', req.method, url.pathname, e);
      return send(res, 500, { error: '服务器内部错误' });
    }
  });

  // ---------------------------------------------------------------- WebSocket

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const sockets = new Map<string, WebSocket>();
  const alive = new WeakSet<WebSocket>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = url.pathname.match(/^\/ws\/rooms\/([A-Z0-9]{6})$/);
    const playerId = new URL(req.url || '/', 'http://x').searchParams.get('playerId') ?? '';
    const token = new URL(req.url || '/', 'http://x').searchParams.get('token') ?? '';
    const room = m ? rooms.get(m[1]) : undefined;
    if (!m || !room || room.closed || !/^[\w-]{1,40}$/.test(playerId) || !tokens.verify('room-v2:'+m[1], playerId, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, m[1], playerId));
  });

  function onSocket(ws: WebSocket, code: string, playerId: string) {
    const room = rooms.get(code);
    if (!room) return ws.close(4404, 'room closed');
    const key = `${code}:${playerId}`;
    // 同一玩家在别处登录：踢掉旧连接
    const prev = sockets.get(key);
    if (prev && prev !== ws) {
      prev.send(JSON.stringify({ type: 'kicked', reason: '你已在其他页面进入该房间' } satisfies ServerMessage));
      prev.close(4000, 'replaced');
    }
    sockets.set(key, ws);
    alive.add(ws);

    const unsubscribe = room.connect(playerId, (msg) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(msg));
      if (msg.type === 'kicked' || msg.type === 'closed') ws.close(1000, msg.type);
    });

    // 每个连接的消息限流：每秒 20 条，超过 5 秒内 150 条直接断开
    let windowStart = Date.now();
    let count = 0;
    let burst = 0;
    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        burst = count > 20 ? burst + count : 0;
        count = 0;
      }
      if (++count > 20) {
        if (burst > 150) ws.close(4429, 'too many messages');
        return;
      }
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msg = parseClientMessage(parsed);
      if (!msg) return;
      const current = rooms.get(code);
      if (!current) return ws.close(4404, 'room closed');
      current.handle(playerId, msg);
    });
    ws.on('pong', () => alive.add(ws));
    ws.on('close', () => {
      unsubscribe();
      if (sockets.get(key) === ws) sockets.delete(key);
    });
    ws.on('error', () => ws.terminate());
  }

  // 清理已断开但未正常关闭的连接
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, 30 * 1000);

  await new Promise<void>((ok) => server.listen(opts.port, opts.host ?? '0.0.0.0', ok));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  if (!opts.quiet) log(`服务已启动：http://localhost:${port}`);

  return {
    server,
    rooms,
    port,
    async close() {
      clearInterval(ping);
      clearInterval(sweep);
      clearInterval(duelTimer);duels.close();
      rooms.shutdown();
      for (const ws of wss.clients) ws.close(1012, 'server restart');
      wss.close();
      await new Promise<void>((ok) => server.close(() => ok()));
      server.closeAllConnections?.();
      store.close();
    },
  };
}
