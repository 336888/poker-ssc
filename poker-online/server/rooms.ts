import { checkSeats, clearInactiveHolds, installCollateral, walletFile } from './collateral';
import { existsSync } from 'node:fs';
import { leaveAmount } from '../src/game/walletFees';
// 房间管理：创建、查找、持久化、重启恢复、清理空闲房间

import { generateInviteCode } from '../src/net/inviteCode';
import type { RoomConfig, RoomSummary } from '../src/net/protocol';
import { RoomServer, randomId } from '../src/net/roomServer';
import type { Store } from './db';
import { log } from './log';
import { bookRound, calcDeltas } from './settle';
import { rtCfg } from './rtcfg';
import { clearResult, putResult, bumpStreak } from './results';

/** 无人在线超过该时间的房间会被清理 */
const IDLE_ROOM_MS = 30 * 60 * 1000;
/** 重启时只恢复最近这段时间内活跃过的房间 */
const RESTORE_MAX_AGE_MS = 6 * 3600 * 1000;
const PERSIST_DEBOUNCE_MS = 1000;

export class RoomManager {
  private rooms = new Map<string, RoomServer>();
  private idleSince = new Map<string, number>();
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private store: Store,
    private maxRooms: number,
  ) {
    if (existsSync(walletFile())) installCollateral();
    this.restore();
    this.reconcileHolds();
    this.sweepTimer = setInterval(() => this.sweep(), 60 * 1000);
  }

  get size() {
    return this.rooms.size;
  }

  get(code: string): RoomServer | undefined {
    return this.rooms.get(code);
  }

  create(hostName: string, config: Partial<RoomConfig>, hostUid?: string, ip?: string, fp?: string): { code: string; hostId: string } {
    if (this.rooms.size >= this.maxRooms) throw new Error('服务器房间已满，请稍后再试');
    // 同机器识别：同一 IP 已有活跃玩家时不允许再开
    if (rtCfg().sameDev && (ip || fp)) {
      for (const srv of this.rooms.values()) {
        if (srv.isIdle()) continue;
        const dup = srv.room.players.find((p) => p.kind === 'human' && p.online && ((p as any).ip === ip || (fp && (p as any).fp === fp)));
        if (dup) throw new Error('检测到同一设备已有玩家在线，请勿多开');
      }
    }
    const code = generateInviteCode((c) => this.rooms.has(c));
    const hostId = hostUid && /^[A-Za-z0-9_]{3,24}$/.test(hostUid) ? hostUid : randomId('host');
    const server = RoomServer.create(code, hostId, hostName, config, ip, fp);
    if (hostUid) {
      if (hostId !== hostUid) throw new Error('棋牌账户标识无效');
      checkSeats([hostUid],server.room.config,rtCfg().minBal);
    }
    // 刚创建时房主还没连上 WebSocket，先视为在线，等心跳超时再判定
    this.wire(server);
    this.persist(server);
    log('房间创建', code, hostName);
    // 20 秒内真人不足时自动补位（期间有真人加入会重新计时）
    this.scheduleAutoFill(code);
    return { code, hostId };
  }

  private autoFillTimers = new Map<string, NodeJS.Timeout>();

  /** 20 秒后检查人数，不够就补 AI；真人满员则跳过 */
  private scheduleAutoFill(code: string) {
    const old = this.autoFillTimers.get(code);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.autoFillTimers.delete(code);
      const server = this.rooms.get(code);
      if (!server) return;
      try {
        const r = server.autoFill();
        if (r.filled) log('补位完成', code, `真人${r.humans} 补${r.filled}`);
      } catch (e) {
        log('补位失败', code, (e as Error).message);
      }
    }, 8000);
    this.autoFillTimers.set(code, t);
  }

  /** 有真人加入/离开时重新计时 */
  rescheduleAutoFill(code: string) {
    const server = this.rooms.get(code);
    if (!server || server.room.status === 'playing') return;
    if (server.humanCount() >= server.room.config.seatCount) {
      const t = this.autoFillTimers.get(code);
      if (t) { clearTimeout(t); this.autoFillTimers.delete(code); }
      return;
    }
    this.scheduleAutoFill(code);
  }

  summaries(): RoomSummary[] {
    return [...this.rooms.values()].filter((r) => !r.closed).map((r) => r.summary());
  }

  close(code: string, reason = '房间已被管理员关闭') {
    const server = this.rooms.get(code);
    if (!server) return false;
    server.destroy(reason);
    this.drop(code);
    return true;
  }

  private wire(server: RoomServer) {
    const code = server.room.code;
    server.hostIsServer = false;
    server.onChange = (s) => {
      if (s.closed) return this.drop(code);
      this.schedulePersist(s);
    };
    const verified=(uid:string)=>this.store.getMeta('wallet:'+code+':'+server.room.createdAt+':'+uid)==='1';
    server.beforeJoin = uid => {
      if (verified(uid)) checkSeats([uid],server.room.config,rtCfg().minBal);
    };
    server.beforeDeal = id => {
      const payers = server.room.players.filter(p => p.kind === 'human' && verified(p.id));
      checkSeats(payers.map(p => p.id),server.room.config,rtCfg().minBal,id);
    };
    server.onRoundFinished = (record) => {
      const rows=record.settlement.map(r=>({uid:r.playerId,name:r.name,rank:r.rank,remaining:r.remaining,role:r.role}));
      const {deltas}=calcDeltas(rows,1,0,record.mode,record.bombs||0);
      const payable=deltas.filter(d=>verified(d.uid)&&record.players.some(p=>p.id===d.uid&&p.kind==='human'));
      record.walletStatus='none';
      if(payable.length){
        try{
          const receipt=bookRound(record.id,payable);
          record.walletStatus='booked';
          record.walletMoves=receipt.moves;
          for(const move of receipt.moves){
            try{
              if(receipt.fresh && move.delta!==0)bumpStreak(move.uid,move.delta>0);
              putResult(move.uid,{delta:move.delta,balance:move.balance,room:code,at:Date.now()});
            }catch(e){log('钱包已入账，战绩更新失败',record.id,String(e))}
          }
        }catch(e){
          for (const move of payable) clearResult(move.uid);
          record.walletStatus='pending';
          record.walletMoves=payable;
          record.walletReason=e instanceof Error?e.message:'钱包入账失败';
          log('整局钱包待核对',record.id,String(e));
        }
      }
      if(record.walletStatus==='pending'){
        server.system('本局钱包未入账，请联系管理员核对。');
      }else{
        server.applyDeltas(deltas);
        for(const row of record.settlement)Object.assign(row,{delta:deltas.find(d=>d.uid===row.playerId)?.delta??0});
      }
      this.store.addHistory(record);
      server.broadcastAll();
    };
    server.onPlayerLeaveMidGame = (uid, _name, mult, role) => {
      const game = server.game;
      if (!game || !verified(uid)) return;
      const id = ['leave', code, server.room.createdAt, game.startedAt, game.round, uid].join(':');
      const amount = this.store.queueLeaveFee(id, uid, leaveAmount(mult, role));
      try {
        bookRound(id, [{ uid, delta: -amount }], '中途退桌');
        this.store.completeLeaveFee(id);
      } catch (error) {
        log('退桌费用待核对', id, String(error));
      }
    };
    server.onModeration = (entry) => {
      log('拦截聊天', code, entry.name, entry.reason);
      this.store.addModeration(code, entry);
    };
    this.rooms.set(code, server);
    server.start();
  }

  private schedulePersist(server: RoomServer) {
    const code = server.room.code;
    if (this.persistTimers.has(code)) return;
    this.persistTimers.set(
      code,
      setTimeout(() => {
        this.persistTimers.delete(code);
        if (!server.closed) this.persist(server);
      }, PERSIST_DEBOUNCE_MS),
    );
  }

  private persist(server: RoomServer) {
    try {
      this.store.saveRoom(server.snapshot());
    } catch (e) {
      log('保存房间失败', server.room.code, e);
    }
  }

  private reconcileHolds() {
    const active = new Set<string>();
    for (const server of this.rooms.values()) {
      const g = server.game;
      if (server.room.status === 'playing' && g)
        active.add([server.room.code,g.round,g.startedAt].join('-'));
    }
    clearInactiveHolds(id => active.has(id) || this.store.historyById(id)?.walletStatus === 'pending'
      || this.store.hasPendingLeaveForRound(id));
  }

  private drop(code: string) {
    const t = this.persistTimers.get(code);
    if (t) clearTimeout(t);
    this.persistTimers.delete(code);
    this.rooms.get(code)?.stop();
    this.rooms.delete(code);
    this.idleSince.delete(code);
    this.store.deleteRoom(code);
    this.reconcileHolds();
    log('房间关闭', code);
  }

  /** 服务器重启后恢复房间：所有真人先标记为离线，等待重连 */
  private restore() {
    const now = Date.now();
    for (const snap of this.store.loadRooms(RESTORE_MAX_AGE_MS)) {
      for (const p of snap.room.players) {
        if (p.kind === 'human') {
          p.online = false;
          p.lastSeen = now;
        }
      }
      // 给玩家留出重连时间
      if (snap.game && snap.game.phase !== 'finished') snap.game.turnStartedAt = Math.max(snap.game.turnStartedAt, now + 5000);
      this.wire(new RoomServer(snap));
    }
    if (this.rooms.size) log(`已恢复 ${this.rooms.size} 个房间`);
  }

  private sweep() {
    try { this.reconcileHolds(); } catch (e) { log('本局担保核对延后', String(e)); }
    const now = Date.now();
    for (const [code, server] of this.rooms) {
      if (!server.isIdle()) {
        this.idleSince.delete(code);
        continue;
      }
      const since = this.idleSince.get(code) ?? now;
      this.idleSince.set(code, since);
      if (now - since > IDLE_ROOM_MS) this.close(code, '房间长时间无人，已自动关闭');
    }
  }

  /** 关闭服务器前把所有房间写入数据库 */
  shutdown() {
    clearInterval(this.sweepTimer);
    for (const t of this.persistTimers.values()) clearTimeout(t);
    this.persistTimers.clear();
    for (const server of this.rooms.values()) {
      server.stop();
      if (!server.closed) this.persist(server);
    }
  }
}
