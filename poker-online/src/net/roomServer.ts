// 房间服务器：权威的房间与牌局逻辑。
// 第一阶段运行在房主的浏览器标签页中；后续可以几乎原样移植到 Node.js 后端。

import { decideBid, decideMove, Personality } from '../game/ai';
import { recommendedDecks } from '../game/cards';
import { GameError, GameState, dealNewGame, isOut, isTeammate, nextSeat, passTurn, placeBid, playCards, viewFor } from '../game/engine';
import { GameRecord, buildRecord } from './adminHistory';
import { EMOJIS, QUICK_PHRASES, checkText, containsBlocked } from './moderation';
import { hardProb, rtCfg } from '../../server/rtcfg';
import {
  ClientMessage,
  DEAL_ANIMATION_MS,
  LANDLORD_REVEAL_MS,
  MAX_PLAYERS,
  MIN_CARDS_PER_PLAYER,
  MIN_PLAYERS,
  ChatMessage,
  ModerationEntry,
  RoomConfig,
  RoomPlayer,
  RoomState,
  RoomSummary,
  ServerMessage,
  defaultConfig,
} from './protocol';

export type Listener = (msg: ServerMessage) => void;

const OFFLINE_AFTER_MS = 6000;
const OFFLINE_TURN_GRACE_MS = 3000;
// 纯 AI 座位也用真实昵称（和补位池错开，避免同名）
const AI_NAMES = ['铁柱哥', '胖虎兄', '孤独患者', '浪迹天涯', '江湖浪子',
                  '独来独往', '今晚吃鸡', '幸运星66', '大吉大利8', 'liuyang666'];
// 补位玩家名字池：模仿真实玩家昵称（小名、网名、数字号混排）
// 补位玩家名字池：真实玩家常见昵称（网名/数字号/土味混排，避免"阿杰、小美"这种 AI 感）
const SIM_NAMES = [
  '往事随风', '笑看人生', '财运亨通', '一路发', '大杀四方', '赌神在世',
  '稳中求胜', '顺其自然', '淡忘一切', '追风少年', '孤独患者', '浪迹天涯',
  '夜猫子', '今晚吃鸡', '不服就干', '常胜将军', '江湖浪子', '独来独往',
  '老张888', '阿良9527', '小胖123', '铁柱哥', '二狗子', '胖虎兄',
  '玩家8823', '用户6677', '幸运星66', '大吉大利8', '5201314', '8888888',
  '13966558822', 'wangwei88', 'liuyang666', 'qq882399', 'zhanghao520', 'chenjie123',
];
const CHAT_KEEP = 30;
const CHAT_MIN_INTERVAL_MS = 1500;
const CHAT_BURST = { count: 5, windowMs: 15000 };
const VIOLATIONS_TO_MUTE = 3;
const MUTE_MS = 2 * 60 * 1000;
/** 后端模式下房主离线超过该时间（且不在牌局中）自动移交给其他在线玩家 */
const HOST_HANDOVER_MS = 30 * 1000;

export function randomId(prefix = 'p'): string {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

export interface RoomSnapshot {
  room: RoomState;
  game: GameState | null;
}

let balanceFetcher: ((uid: string) => Promise<number | null>) | null = null;
/** server 层注入余额查询（避免前端打包到 node crypto） */
export function setBalanceFetcher(fn: (uid: string) => Promise<number | null>) { balanceFetcher = fn; }

export class RoomServer {
  room: RoomState;
  game: GameState | null;
  private listeners = new Map<string, Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingAutoAt: number | null = null;
  private version = 0;
  closed = false;
  /**
   * 房主是否就是"服务器"本身（本地模拟模式）。
   * 真实后端中房主只是普通客户端：同样按心跳判断在线，长时间离线会自动移交房主。
   */
  hostIsServer = true;
  /** 状态变更回调（持久化、更新房间列表） */
  onChange: ((server: RoomServer) => void) | null = null;
  /** 每局结束回调（写入后台历史记录） */
  onRoundFinished: ((record: GameRecord) => void) | null = null;
  /** 游戏中主动离开时触发（用于扣房间费） */
  onPlayerLeaveMidGame: ((uid: string, name: string, mult: number, role?: string) => void) | null = null;
  /** 拦截到违规聊天时回调（后端写入数据库） */
  onModeration: ((entry: ModerationEntry) => void) | null = null;
  /** 被拦截的聊天记录（只进入后台概要，不推送给玩家） */
  moderation: ModerationEntry[] = [];
  private chatTimes = new Map<string, number[]>();
  private violations = new Map<string, number[]>();
  private mutedUntil = new Map<string, number>();

  constructor(snapshot: RoomSnapshot) {
    this.room = snapshot.room;
    // 兼容旧版本快照
    this.room.config = { ...defaultConfig(), ...this.room.config };
    delete (this.room as { history?: unknown }).history;
    delete (this.room as { scores?: unknown }).scores;
    this.room.chat ??= [];
    this.game = snapshot.game;
  }

  static create(code: string, hostId: string, hostName: string, config?: Partial<RoomConfig>, ip?: string, fp?: string): RoomServer {
    const now = Date.now();
    const room: RoomState = {
      code,
      hostId,
      createdAt: now,
      config: { ...defaultConfig(), ...config },
      players: [
        { id: hostId, name: hostName, kind: 'human', isHost: true, online: true, ready: true, autoPlay: false, joinedAt: now, lastSeen: now, latency: 0, ip, fp } as any,
      ],
      status: 'waiting',
      round: 0,
      lastWinnerId: null,
      chat: [],
    };
    const server = new RoomServer({ room, game: null });
    server.normalizeConfig();
    return server;
  }

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 400);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  destroy(reason = '房间已关闭'): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const l of this.listeners.values()) l({ type: 'closed', reason });
    this.listeners.clear();
  }

  snapshot(): RoomSnapshot {
    return { room: this.room, game: this.game };
  }

  /** 玩家连接（收到推送）。返回断开函数 */
  connect(playerId: string, listener: Listener): () => void {
    this.listeners.set(playerId, listener);
    this.sendState(playerId);
    return () => {
      if (this.listeners.get(playerId) === listener) this.listeners.delete(playerId);
    };
  }

  /** 主动推送一次状态给所有连接（结算后刷新金额用） */
  /** 把输赢金额写进当前局的结算行 */
  applyDeltas(deltas: { uid: string; delta: number }[]): void {
    const g = this.game;
    if (!g || !g.settlement) return;
    const map = new Map(deltas.map((d) => [d.uid, d.delta]));
    for (const r of g.settlement) {
      const v = map.get(r.playerId);
      if (typeof v === 'number') (r as any).delta = v;
    }
  }

  system(message:string):void {
    for(const listener of this.listeners.values())listener({type:'error',message});
  }

  broadcastAll(): void {
    for (const [pid] of this.listeners) {
      try { this.sendState(pid); } catch { /* 单个失败忽略 */ }
    }
  }

  isMember(playerId: string): boolean {
    return this.room.players.some((p) => p.id === playerId);
  }

  // ---------------------------------------------------------------- 消息处理

  /** 跨局记忆：玩家历史胜负 */
  private playerWins = new Map<string, { win: number; total: number }>();
  /** 机器人情绪：负=连败，正=连胜 */
  private botMood = new Map<string, number>();

  /** 时段因子：深夜反应更慢 */
  private hourFactor(): number {
    const h = new Date().getHours();
    if (h >= 1 && h < 6) return 1.7;   // 凌晨 1-6 点最慢
    if (h >= 6 && h < 9) return 1.25;  // 清晨稍慢
    if (h >= 23) return 1.35;          // 深夜偏慢
    return 1;
  }

  /** 玩家行为统计（用于 AI 学习）：过牌次数 / 总行动 / 出大牌次数 */
  private playerStats = new Map<string, { pass: number; total: number; big: number }>();

  /** 每个机器人的固定性格（用 id 哈希，重启也不变） */
  /** 机器人虚拟余额（按 id 哈希稳定，500~5000） */
  private virtualBalance(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    const base = 500 + Math.abs(h % 4500);
    return Math.round(base * 100) / 100;
  }

  private botPersona(id: string): Personality {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    const r = (n: number) => Math.abs((h >> n) % 100) / 100;
    const mood = this.botMood.get(id) ?? 0;
    // 情绪：连败想翻本（更激进），连胜变保守（守住）
    const moodAggr = mood < 0 ? Math.min(0.25, Math.abs(mood) * 0.08)
                   : mood > 0 ? -Math.min(0.2, mood * 0.07) : 0;
    return {
      aggression: Math.max(0, Math.min(1, r(0) + moodAggr)),
      patience: Math.max(0, Math.min(1, r(4) - moodAggr * 0.6)),
      mistake: 0.02 + r(8) * 0.1,
      memory: { ...this.oppMemory(id), oppWinRate: this.oppWinRate(id) },
    };
  }

  /** 对手胜率（跨局记忆）：赢得多说明强 */
  private oppWinRate(botId: string): number {
    let win = 0, total = 0;
    for (const [uid, st] of this.playerWins) {
      if (uid === botId) continue;
      win += st.win; total += st.total;
    }
    return total ? win / total : 0.33;
  }

  /** 从玩家统计里算出对手画像 */
  private oppMemory(botId: string): Personality['memory'] {
    let pass = 0, total = 0, big = 0;
    for (const [uid, st] of this.playerStats) {
      if (uid === botId) continue;
      pass += st.pass; total += st.total; big += st.big;
    }
    if (!total) return { oppPassRate: 0.3, oppBigRate: 0.2 };
    return { oppPassRate: pass / total, oppBigRate: big / Math.max(1, total - pass) };
  }

  /** 记录一次行动（用于学习） */
  private noteAction(uid: string, played: boolean, cardCount: number) {
    const st = this.playerStats.get(uid) ?? { pass: 0, total: 0, big: 0 };
    st.total += 1;
    if (!played) st.pass += 1;
    else if (cardCount >= 5) st.big += 1;
    this.playerStats.set(uid, st);
  }

  /** 已扣过房间费的玩家（防重复 leave 重复扣费） */
  private chargedLeavers = new Set<string>();

  /** 消息频率窗口：防脚本高频刷操作 */
  private msgWindow = new Map<string, { count: number; at: number }>();
  /** 上一手操作时间：防机器级操作速度 */
  private lastAct = new Map<string, number>();

  handle(playerId: string, msg: ClientMessage): void {
    try {
      const now = Date.now();
      const w = this.msgWindow.get(playerId);
      if (!w || now - w.at > 1000) {
        this.msgWindow.set(playerId, { count: 1, at: now });
      } else {
        w.count += 1;
        if (w.count > rtCfg().msgRate) throw new GameError('操作过于频繁，请稍后再试');
      }
      // 出牌/叫地主类操作：人类反应不会低于 250ms，过快视为脚本
      if (msg.type === 'play' || msg.type === 'bid' || msg.type === 'pass') {
        const prev = this.lastAct.get(playerId) ?? 0;
        if (prev && now - prev < rtCfg().actMs) throw new GameError('操作过快，请放慢速度');
        this.lastAct.set(playerId, now);
      }
      this.dispatch(playerId, msg);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.listeners.get(playerId)?.({ type: 'error', message });
    }
  }

  private dispatch(playerId: string, msg: ClientMessage): void {
    const now = Date.now();
    if (msg.type === 'join') return this.join(playerId, msg.name);

    const me = this.room.players.find((p) => p.id === playerId);
    if (!me) throw new GameError('你不在该房间中');
    me.lastSeen = now;
    const wasOffline = !me.online;
    me.online = true;
    const isHost = playerId === this.room.hostId;

    switch (msg.type) {
      case 'heartbeat':
        me.latency = Math.max(1, now - msg.sentAt);
        // 心跳回包：让客户端确认与服务器的连接仍然正常
        if (wasOffline) this.changed();
        else this.sendState(playerId);
        return;
      case 'leave':
        return this.leave(me);
      case 'ready':
        if (this.room.status === 'playing') throw new GameError('游戏进行中');
        me.ready = isHost ? true : msg.ready;
        return this.changed();
      case 'config':
        this.requireHost(isHost);
        if (this.room.status === 'playing') throw new GameError('游戏进行中不能修改设置');
        this.room.config = { ...this.room.config, ...msg.patch };
        if (msg.patch.deckCount !== undefined) this.room.config.deckManual = true;
        if (msg.patch.seatCount !== undefined) this.room.config.autoSeats = false;
        this.normalizeConfig();
        return this.changed();
      case 'addSimulated':
        this.requireHost(isHost);
        return this.addSimulated();
      case 'kick':
        // 房间内不允许移出任何玩家
        throw new GameError('当前不支持移出玩家');
      case 'start':
        this.requireHost(isHost);
        if (this.room.status !== 'waiting') throw new GameError('游戏已经开始');
        return this.startRound();
      case 'nextRound':
        this.requireHost(isHost);
        if (this.room.status !== 'finished') throw new GameError('本局尚未结束');
        return this.startRound();
      case 'backToLobby':
        this.requireHost(isHost);
        if (this.room.status === 'playing') throw new GameError('游戏进行中');
        this.room.status = 'waiting';
        this.game = null;
        this.room.players = this.room.players.filter((p) => p.kind !== 'ai');
        for (const p of this.room.players) if (p.kind === 'human' && !p.isHost) p.ready = false;
        this.normalizeConfig();
        return this.changed();
      case 'play':
        this.requireGame();
        this.game = playCards(this.game!, playerId, msg.cardIds);
        return this.afterMove();
      case 'pass':
        this.requireGame();
        this.game = passTurn(this.game!, playerId);
        return this.afterMove();
      case 'bid':
        this.requireGame();
        this.game = placeBid(this.game!, playerId, msg.call);
        return this.afterMove('bidding');
      case 'autoPlay':
        me.autoPlay = msg.on;
        return this.changed();
      case 'chat':
        return this.chat(me, msg.kind, msg.content, now);
    }
  }

  // ---------------------------------------------------------------- 聊天

  private chat(me: RoomPlayer, kind: ChatMessage['kind'], content: string, now: number): void {
    const policy = this.room.config.chat;
    if (policy === 'off') throw new GameError('房主已关闭聊天');
    const muted = this.mutedUntil.get(me.id) ?? 0;
    if (now < muted) throw new GameError(`你已被禁言，${Math.ceil((muted - now) / 1000)} 秒后可再次发言`);

    // 频率限制
    const times = (this.chatTimes.get(me.id) ?? []).filter((t) => now - t < CHAT_BURST.windowMs);
    if (times.length && now - times[times.length - 1] < CHAT_MIN_INTERVAL_MS) throw new GameError('发言太快了，请稍后再试');
    if (times.length >= CHAT_BURST.count) throw new GameError('发言太频繁，请稍后再试');

    let text: string;
    if (kind === 'phrase') {
      if (!(QUICK_PHRASES as readonly string[]).includes(content)) throw new GameError('无效的短语');
      text = content;
    } else if (kind === 'emoji') {
      if (!(EMOJIS as readonly string[]).includes(content)) throw new GameError('无效的表情');
      text = content;
    } else {
      if (policy !== 'full') throw new GameError('房主只允许发送快捷短语和表情');
      const result = checkText(content);
      if (!result.ok) {
        this.recordViolation(me, content, result.reason, now);
        const mutedNow = (this.mutedUntil.get(me.id) ?? 0) > now;
        throw new GameError(mutedNow ? `${result.reason}。多次违规，已被禁言 2 分钟` : result.reason);
      }
      text = result.text;
    }

    this.chatTimes.set(me.id, [...times, now]);
    this.room.chat = [...this.room.chat, { id: randomId('m'), playerId: me.id, name: me.name, kind, content: text, at: now }].slice(-CHAT_KEEP);
    this.changed();
  }

  private recordViolation(me: RoomPlayer, content: string, reason: string, now: number) {
    this.moderation = [{ playerId: me.id, name: me.name, content: content.slice(0, 40), reason, at: now }, ...this.moderation].slice(0, 50);
    const recent = [...(this.violations.get(me.id) ?? []).filter((t) => now - t < 5 * 60 * 1000), now];
    this.violations.set(me.id, recent);
    if (recent.length >= VIOLATIONS_TO_MUTE) {
      this.mutedUntil.set(me.id, now + MUTE_MS);
      this.violations.set(me.id, []);
      this.moderation[0].reason += '（已自动禁言 2 分钟）';
    }
    this.onModeration?.(this.moderation[0]);
    this.onChange?.(this);
  }

  private requireHost(isHost: boolean) {
    if (!isHost) throw new GameError('只有房主可以执行此操作');
  }

  private requireGame() {
    if (!this.game || this.room.status !== 'playing') throw new GameError('游戏未开始');
  }

  private humans(): RoomPlayer[] {
    return this.room.players.filter((p) => p.kind !== 'ai');
  }

  private capacity(): number {
    const max = this.room.config.mode === 'doudizhu' ? 4 : MAX_PLAYERS;
    return this.room.config.autoSeats ? max : Math.min(max, this.room.config.seatCount);
  }

  private join(playerId: string, name: string): void {
    const now = Date.now();
    const existing = this.room.players.find((p) => p.id === playerId);
    if (existing) {
      // 断线重连
      existing.online = true;
      existing.lastSeen = now;
      this.listeners.get(playerId)?.({ type: 'joined', playerId, code: this.room.code });
      return this.changed();
    }
    if (this.room.status !== 'waiting') throw new GameError('游戏进行中，暂时无法加入');
    if (this.humans().length >= this.capacity()) throw new GameError('房间已满');
    const clean = name.trim().slice(0, 12) || '玩家';
    if (containsBlocked(clean)) throw new GameError('昵称包含不文明内容，请修改后再加入');
    this.room.players.push({
      id: playerId,
      name: this.uniqueName(clean),
      kind: 'human',
      isHost: false,
      online: true,
      ready: false,
      autoPlay: false,
      joinedAt: now,
      lastSeen: now,
      latency: 0,
    });
    this.normalizeConfig();
    this.listeners.get(playerId)?.({ type: 'joined', playerId, code: this.room.code });
    this.changed();
  }

  private leave(me: RoomPlayer): void {
    if (me.isHost) {
      // 房主在对局中解散，同样扣房间费
      if (this.room.status === 'playing' && me.kind === 'human' && !this.chargedLeavers.has(me.id)) {
        this.chargedLeavers.add(me.id);
        const pay = this.leavePayInfo(me.id);
        try { this.onPlayerLeaveMidGame?.(me.id, me.name, pay.mult, pay.role); } catch { /* 忽略 */ }
      }
      this.destroy('房主已解散房间');
      this.onChange?.(this);
      return;
    }
    this.listeners.delete(me.id);
    if (this.room.status === 'playing') {
      me.online = false;
      me.autoPlay = true;
      // 对局中退出：扣房间费（每个玩家只扣一次）
      if (me.kind === 'human' && !this.chargedLeavers.has(me.id)) {
        this.chargedLeavers.add(me.id);
        const pay = this.leavePayInfo(me.id);
        try { this.onPlayerLeaveMidGame?.(me.id, me.name, pay.mult, pay.role); } catch { /* 忽略扣费异常 */ }
      }
    } else {
      this.room.players = this.room.players.filter((p) => p !== me);
      this.normalizeConfig();
    }
    this.changed();
  }

  /** 中途退出赔付信息：按当前剩余牌算倍数、按座位算角色 */
  private leavePayInfo(playerId: string): { mult: number; role?: string } {
    const g = this.game;
    if (!g) return { mult: 1 };
    const lefts = this.room.players.map((p) => g.hands?.[p.id]?.length ?? 0);
    const maxLeft = Math.max(0, ...lefts);
    const mult = maxLeft >= 15 ? 4 : maxLeft >= 10 ? 2 : 1;
    const seatIdx = g.seats.findIndex((x) => x.id === playerId);
    // 还没定地主时按普通赔（不算地主翻倍）
    const role = g.mode !== 'doudizhu' || g.landlordSeat == null ? undefined
               : g.landlordSeat === seatIdx ? 'landlord' : 'farmer';
    return { mult, role };
  }

  private uniqueName(name: string): string {
    const names = new Set(this.room.players.map((p) => p.name));
    if (!names.has(name)) return name;
    for (let i = 2; ; i++) if (!names.has(`${name}${i}`)) return `${name}${i}`;
  }

  /** 真人不够时自动补位（优先真人，缺几个补几个） */
  autoFill(): { filled: number; humans: number } {
    if (this.room.status === 'playing') return { filled: 0, humans: this.humans().length };
    const humans = this.humans().length;
    let filled = 0;
    // 补位目标：斗地主 3~4 人、跑得快固定 3 人（不按 autoSeats 的 8 人上限）
    const want = this.room.config.mode === 'doudizhu'
      ? Math.min(4, Math.max(3, this.room.config.seatCount))
      : 3;
    const target = Math.min(this.capacity(), want);
    const need = target - this.room.players.length;
    // 分批入场：每个人间隔 3~8 秒，看起来像真人陆续加入
    for (let i = 0; i < need; i++) {
      const delay = 2500 + i * 4500 + Math.random() * 3500;
      setTimeout(() => {
        if (this.room.status === 'playing' ) return;
        if (this.room.players.length >= target) return;
        try { this.addSimulated(); } catch { /* 满了就停 */ }
      }, delay);
      filled++;
    }
    if (filled) console.log('自动补位', this.room.code, `真人${humans} 计划补${filled}`);
    return { filled, humans };
  }

  /** 当前真人数量 */
  humanCount(): number {
    return this.humans().length;
  }

  private addSimulated(): void {
    if (this.room.status === 'playing') throw new GameError('游戏进行中');
    if (this.humans().length >= this.capacity()) throw new GameError('房间已满');
    const used = new Set(this.room.players.map((p) => p.name));
    // 名字跟随主系统假人池，随机取
    const pool = rtCfg().names?.length ? rtCfg().names : SIM_NAMES;
    const avail = pool.filter((n) => !used.has(n));
    const name = avail.length
      ? avail[Math.floor(Math.random() * avail.length)]
      : this.uniqueName(pool[0] || '玩家');
    const now = Date.now();
    const id = randomId('sim');
    this.room.players.push({
      id,
      name,
      kind: 'simulated',
      balance: this.virtualBalance(randomId('sim')),
      isHost: false,
      online: true,
      ready: false,
      autoPlay: false,
      // 模拟玩家在加入 0.6~2 秒后自动准备
      // 真实玩家进来后要看一眼，2~5 秒才点准备
      joinedAt: now + 2000 + Math.random() * 3000,
      lastSeen: now,
      latency: 20 + Math.round(Math.random() * 60),
    });
    this.normalizeConfig();
    this.changed();

    // 补位玩家偶尔冒一句快捷短语（像真人随口说话）
    if (Math.random() < 0.55) {
      setTimeout(() => {
        try {
          const p = this.room.players.find((x) => x.id === id);
          if (!p ) return;
          if (this.room.config.chat === 'off') return;
          const phrase = QUICK_PHRASES[Math.floor(Math.random() * QUICK_PHRASES.length)];
          this.chat(p, 'phrase', phrase, Date.now());
        } catch { /* 忽略 */ }
      }, 3000 + Math.random() * 9000);
    }
  }

  /** 修正配置：座位数、推荐牌副数、最少手牌数 */
  private normalizeConfig(): void {
    const c = this.room.config;
    const humans = this.humans().length;
    if (c.mode === 'doudizhu') {
      // 斗地主固定 3 人 1 副 54 张（人数不可调）
      c.seatCount = 3;
      c.deckCount = 1;
      c.withJokers = true;
      c.autoSeats = false;
      c.deckManual = true;
      c.turnSeconds = 15;
      return;
    }
    // 跑得快固定 52 张（不含大小王），出牌限时固定 15 秒
    c.withJokers = false;
    c.turnSeconds = 15;
    if (c.autoSeats) c.seatCount = Math.max(MIN_PLAYERS, humans);
    c.seatCount = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, humans, Math.round(c.seatCount)));
    if (!c.deckManual) c.deckCount = recommendedDecks(c.seatCount);
    const perDeck = c.withJokers ? 54 : 52;
    const minDecks = Math.ceil((c.seatCount * MIN_CARDS_PER_PLAYER) / perDeck);
    c.deckCount = Math.min(8, Math.max(minDecks, 1, Math.round(c.deckCount)));
    c.turnSeconds = Math.max(0, Math.min(120, Math.round(c.turnSeconds)));
  }

  private startRound(): void {
    void this.refreshBalances();
    // 必须坐满才能开局（补位玩家也要先到齐）
    const need = this.room.config.seatCount - this.room.players.length;
    if (need > 0) {
      throw new GameError(`还差 ${need} 人，请等待匹配完成`);
    }
    const notReady = this.humans().filter((p) => !p.ready && !p.isHost);
    if (notReady.length) throw new GameError(`还有玩家未准备：${notReady.map((p) => p.name).join('、')}`);

    // 再来一局时移除已离线的真人玩家
    if (this.room.status === 'finished') {
      this.room.players = this.room.players.filter((p) => p.kind === 'ai' || p.online || p.isHost);
    }
    this.normalizeConfig();
    let seatsNeeded = 0;
    const usedNames = new Set(this.room.players.map((p) => p.name));
    const aiNames = AI_NAMES.filter((n) => !usedNames.has(n));
    for (let i = 0; i < seatsNeeded; i++) {
      const id = randomId('ai');
      const now = Date.now();
      this.room.players.push({
        id,
        name: aiNames[i] ?? `玩家${1000 + i}`,
        kind: 'ai',
        isHost: false,
        online: true,
        ready: true,
        autoPlay: false,
        joinedAt: now,
        lastSeen: now,
        latency: 0,
      });
    }

    this.room.round += 1;
    this.deal();
    this.room.status = 'playing';
    this.changed();
  }

  private deal(): void {
    this.game = dealNewGame({
      mode: this.room.config.mode,
      seats: this.room.players.map((p) => ({ id: p.id, name: p.name, isAI: p.kind === 'ai' })),
      deckCount: this.room.config.deckCount,
      withJokers: this.room.config.withJokers,
      round: this.room.round,
      previousWinnerId: this.room.lastWinnerId,
    });
    // 等待客户端播放完洗牌、发牌动画后才开始计时
    this.game.turnStartedAt = Date.now() + DEAL_ANIMATION_MS;
    this.pendingAutoAt = null;
  }

  private afterMove(prevPhase?: GameState['phase']): void {
    this.pendingAutoAt = null;
    const g = this.game!;
    if (g.bidding?.allPassed) {
      // 无人叫地主：重新洗牌发牌
      this.deal();
      this.game!.redealt = (g.redealt ?? 0) + 1;
    } else if (prevPhase === 'bidding' && g.phase === 'playing') {
      // 叫完地主：留出翻底牌动画时间
      g.turnStartedAt = Date.now() + LANDLORD_REVEAL_MS;
    }
    if (g.phase === 'finished' && g.settlement) {
      this.room.status = 'finished';
      this.room.lastWinnerId = g.seats[g.winnerSeat!].id;
      // 跨局记忆 + 情绪更新
      for (const r of g.settlement) {
        const st = this.playerWins.get(r.playerId) ?? { win: 0, total: 0 };
        st.total += 1;
        if (r.rank === 1) st.win += 1;
        this.playerWins.set(r.playerId, st);
        const pl = this.room.players.find((x) => x.id === r.playerId);
        if (pl && (pl.kind === 'ai' || pl.kind === 'simulated')) {
          const m = this.botMood.get(pl.id) ?? 0;
          this.botMood.set(pl.id, r.rank === 1 ? Math.max(0, m) + 1 : Math.min(0, m) - 1);
        }
      }
      this.onRoundFinished?.(buildRecord(this.room, g));
      void this.refreshBalances();
      this.botReaction(g);
    }
    this.changed();
  }

  // ---------------------------------------------------------------- 定时任务

  tick(now = Date.now()): void {
    let dirty = false;
    for (const p of this.room.players) {
      if (p.kind === 'human' && (!p.isHost || !this.hostIsServer) && p.online && now - p.lastSeen > OFFLINE_AFTER_MS) {
        p.online = false;
        dirty = true;
      }
      if (p.kind === 'simulated' && !p.ready && now >= p.joinedAt) {
        p.ready = true;
        dirty = true;
      }
    }
    if (!this.hostIsServer && this.room.status !== 'playing') dirty = this.handoverHost(now) || dirty;
    if (this.room.status === 'playing' && this.game) {
      if (this.runAutomation(now)) return; // 内部已广播
    }
    if (dirty) this.changed();
  }

  private handoverHost(now: number): boolean {
    const host = this.room.players.find((p) => p.isHost);
    if (!host || host.online || now - host.lastSeen < HOST_HANDOVER_MS) return false;
    const next = this.room.players.find((p) => p.kind === 'human' && p.online && !p.isHost);
    if (!next) return false;
    host.isHost = false;
    next.isHost = true;
    next.ready = true;
    this.room.hostId = next.id;
    return true;
  }

  /** 机器人固定手速：用 id 哈希，同一个机器人始终同样快慢 */
  private botSpeed(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    const r = Math.abs(h % 100) / 100;
    return 500 + r * 4500;
  }

  /** 对局结束时机器人随口反应一句 */
  private botReaction(g: GameState): void {
    if (this.room.config.chat === 'off') return;
    const win = new Set((g.winners ?? [g.winnerSeat ?? 0]).map((i) => g.seats[i].id));
    const bots = this.room.players.filter((p) => p.kind === 'simulated' || p.kind === 'ai');
    for (const b of bots) {
      if (Math.random() > 0.45) continue;
      // 情绪影响说话内容
      const mood = this.botMood.get(b.id) ?? 0;
      const pool = win.has(b.id)
        ? (mood >= 2
            ? ['承让', '哈哈', '运气好', '666']          // 连胜：得意
            : ['承让', '哈哈', '666', '厉害', '谢谢'])
        : (mood <= -2
            ? ['再来', '失误', '抱歉', '唉']             // 连败：沮丧
            : ['再来', '失误', '稍等', '抱歉', '加油']);
      const phrase = pool[Math.floor(Math.random() * pool.length)];
      setTimeout(() => {
        try { this.chat(b, 'phrase', phrase, Date.now()); } catch { /* 忽略 */ }
      }, 800 + Math.random() * 2500);
    }
  }

  /** 是否已经没有任何真人在线（用于后端清理空房间） */
  isIdle(): boolean {
    return !this.room.players.some((p) => p.kind === 'human' && p.online);
  }

  /** 需要由 AI 代替出牌的情况：AI、模拟玩家、托管、超时、掉线 */
  private runAutomation(now: number): boolean {
    const g = this.game!;
    const seat = g.seats[g.turn];
    const player = this.room.players.find((p) => p.id === seat.id);
    if (!player || now < g.turnStartedAt) return false;

    let delay: number | null = null;
    if (player.kind === 'ai' || player.kind === 'simulated') {
      // 每个机器人有固定手速（0.5~5 秒），出牌时上下浮动
      const base = this.botSpeed(player.id);
      // 时段因子：深夜更慢，像真人犯困
      delay = Math.max(400, base * (0.6 + Math.random() * 0.8) * this.hourFactor());
    }
    else if (player.autoPlay) delay = 600;
    else if (!player.online) delay = OFFLINE_TURN_GRACE_MS;
    else if (this.room.config.turnSeconds > 0 && now - g.turnStartedAt > this.room.config.turnSeconds * 1000) {
      player.autoPlay = true; // 超时自动托管
      delay = 0;
    }
    if (delay === null) return false;

    if (this.pendingAutoAt === null) this.pendingAutoAt = now + delay;
    if (now < this.pendingAutoAt) return false;

    this.pendingAutoAt = null;
    // 补位机器人：70% 普通 + 30% 困难，混合后胜率约 63%
    const isBot = player.kind === 'ai' || player.kind === 'simulated';
    const level = isBot
      ? (Math.random() < hardProb(g.mode) ? 'hard' : 'normal')
      : this.room.config.aiLevel;
    const prevPhase = g.phase;

    if (g.phase === 'bidding') {
      this.game = placeBid(g, seat.id, decideBid(g.hands[seat.id], g.bidding!.candidate !== null, level), now);
      this.afterMove(prevPhase);
      return true;
    }

    const next = nextSeat(g, g.turn);
    const opponents = g.seats.map((_, i) => i).filter((i) => !isTeammate(g, i, g.turn) && !isOut(g, i));
    const cards = decideMove({
      hand: g.hands[seat.id],
      target: g.lastPlay?.pattern ?? null,
      minOpponentCards: opponents.length ? Math.min(...opponents.map((i) => g.hands[g.seats[i].id].length)) : 99,
      nextPlayerCards: g.hands[g.seats[next].id].length,
      mode: g.mode,
      level,
      teammateOnTop: g.lastPlay !== null && g.lastPlay.seat !== g.turn && isTeammate(g, g.lastPlay.seat, g.turn),
      nextIsTeammate: isTeammate(g, next, g.turn),
      personality: isBot ? this.botPersona(seat.id) : undefined,
      played: g.log.flatMap((e) => e.cards ?? []),
    });
    this.noteAction(seat.id, !!cards, cards ? cards.length : 0);
    try {
      // 诊断：记录 AI 每次决策
      console.log('AI决策', this.room.code, player.name,
        cards ? '出' + cards.length + '张' : '过牌',
        '手牌' + (g.hands[seat.id]?.length || 0),
        '目标' + (g.lastPlay ? (g.lastPlay.pattern?.type || '?') : '领出'));
      this.game = cards ? playCards(g, seat.id, cards.map((c) => c.id), now) : passTurn(g, seat.id, now);
    } catch (e2) {
      console.log('AI异常', this.room.code, player.name, (e2 as Error).message);
      // 兜底：AI 给出了不合法的牌，领出时出最小单张，否则过牌
      this.game = g.lastPlay ? passTurn(g, seat.id, now) : playCards(g, seat.id, [g.hands[seat.id][0].id], now);
    }
    this.afterMove(prevPhase);
    return true;
  }

  // ---------------------------------------------------------------- 推送

  private changed(): void {
    this.version++;
    for (const id of this.listeners.keys()) this.sendState(id);
    this.onChange?.(this);
  }

  private sendState(playerId: string): void {
    const listener = this.listeners.get(playerId);
    if (!listener) return;
    listener({
      type: 'state',
      view: {
        room: this.room,
        game: this.game ? viewFor(this.game, playerId) : null,
        you: playerId,
        serverTime: Date.now(),
        version: this.version,
      },
    });
  }

  /** 刷新房间内真人的棋牌钱包余额（fetcher 由 server 层注入，避免前端打包 node 模块） */
  async refreshBalances(): Promise<void> {
    if (!balanceFetcher) return;
    for (const p of this.room.players) {
      if (p.kind !== 'human') continue;
      // SSO 玩家 id 就是主站 uid（可能是 host_ 前缀的游客，查不到就跳过）
      if (!/^[A-Za-z0-9_]{2,40}$/.test(p.id)) continue;
      try {
        const v = await balanceFetcher(p.id);
        if (typeof v === 'number' && !Number.isNaN(v)) p.balance = Math.round(v * 100) / 100;
      } catch { /* ignore */ }
    }
    // 刷新完广播一次，让前端立刻显示余额
    try {
      for (const [pid] of this.listeners) this.sendState(pid);
    } catch { /* ignore */ }
  }

  summary(): RoomSummary {
    const r = this.room;
    const g = this.game;
    const host = r.players.find((p) => p.isHost);
    return {
      code: r.code,
      hostName: host?.name ?? '-',
      mode: r.config.mode,
      status: r.status,
      round: r.round,
      seatCount: r.config.seatCount,
      deckCount: r.config.deckCount,
      withJokers: r.config.withJokers,
      createdAt: r.createdAt,
      updatedAt: Date.now(),
      players: r.players.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        isHost: p.isHost,
        online: p.online,
        ready: p.ready,
        autoPlay: p.autoPlay,
        latency: p.latency,
        cards: g ? g.hands[p.id]?.length ?? null : null,
        balance: p.balance,
      })),
      turnPlayer: g && g.phase !== 'finished' ? g.seats[g.turn].name : null,
      totalPlays: g ? g.log.filter((l) => l.action === 'play').length : 0,
      chat: r.chat.slice(-15),
      moderation: this.moderation.slice(0, 20),
    };
  }
}
