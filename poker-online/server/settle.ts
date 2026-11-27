import { runningMultiplier } from '../src/game/walletFees';
// 资金结算：把牌局结果同步到主站余额
// 规则：底分 1 元；第 1 名 +2、第 3 名 -2（第 2 名不变）；赢家抽水 5%

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const MAIN = process.env.MAIN_API || 'http://127.0.0.1:8090';
const SECRET = process.env.POKER_SSO_SECRET || '';

export interface SettleRow {
  uid: string;
  name: string;
  rank: number;
  remaining: number;
  role?: string;   // doudizhu: landlord / farmer
}

function sig(uid: string, ts: number, amount: number, action: string): string {
  return createHmac('sha256', SECRET).update(`${uid}:${ts}:${amount}:${action}`).digest('hex').slice(0, 32);
}

async function bridge(uid: string, action: string, amount = 0, detail?: Record<string, unknown>) {
  if (!SECRET) throw new Error('未配置 POKER_SSO_SECRET');
  const ts = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = { uid, ts, sig: sig(uid, ts, amount, action), action, amount };
  if (detail) body.detail = detail;
  const r = await fetch(`${MAIN}/api/poker/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) throw new Error(j.msg || `bridge ${action} 失败`);
  return j.data;
}

/** 倍数：炸弹/春天简化按剩余牌差放大，最高 4 倍 */
function multiplier(rows: SettleRow[]): number {
  const last = rows.find((r) => r.rank === 3);
  if (!last) return 1;
  if (last.remaining >= 15) return 4;
  if (last.remaining >= 10) return 2;
  return 1;
}

/** 一局结束结算：赢家加钱、输家扣钱 */
/** 纯计算：算出每个玩家的输赢金额（不调接口） */
export function calcDeltas(
  rows: SettleRow[],
  base = 1,
  rake = 0.05,
  mode: string = "paodekuai",
  bombs = 0,
) {
  // 倍数：跑得快按炸弹数翻倍（1 炸 2 倍 / 2 炸 4 倍 / 3 炸 8 倍）
  // 斗地主仍按剩余牌差
  const mult = mode === "paodekuai"
    ? runningMultiplier(bombs)
    : multiplier(rows);
  const pot = base * mult;
  const deltas: { uid: string; delta: number }[] = [];

  if (mode === "doudizhu") {
    const lord = rows.find((r) => r.role === "landlord");
    const farmers = rows.filter((r) => r.role === "farmer");
    const lordWon = lord && farmers.length ? farmers.every((f) => f.rank >= 2) : false;
    if (lord) {
      if (lordWon) {
        deltas.push({ uid: lord.uid, delta: Math.round(pot * farmers.length * (1 - rake) * 100) / 100 });
        for (const f of farmers) deltas.push({ uid: f.uid, delta: -pot });
      } else {
        deltas.push({ uid: lord.uid, delta: -pot * farmers.length });
        for (const f of farmers) deltas.push({ uid: f.uid, delta: Math.round(pot * (1 - rake) * 100) / 100 });
      }
    }
  } else {
    // ===== 跑得快：先出完的人赢，其余人按手上剩余牌数付钱 =====
    // 例：3 人底注 1，A 出完(0张)、B 剩 5 张、C 剩 8 张
    //     B 输 5，C 输 8，A 赢 (5+8)×(1-rake)
    const winner = rows.find((r) => r.rank === 1);
    const others = rows.filter((r) => r.rank !== 1);
    if (winner && others.length) {
      let totalLose = 0;
      for (const r of others) {
        // 剩余 0 张或 1 张：不计算输赢
        const cards = Number(r.remaining) || 0;
        if (cards <= 1) {
          deltas.push({ uid: r.uid, delta: 0 });
          continue;
        }
        // 剩 2 张以上：每张 = 底注 × 倍数
        const lose = Math.round(cards * pot * 100) / 100;
        totalLose += lose;
        deltas.push({ uid: r.uid, delta: -lose });
      }
      // 赢家拿下所有输家的钱，扣抽水
      const win = Math.round(totalLose * (1 - rake) * 100) / 100;
      deltas.push({ uid: winner.uid, delta: win });
    }
  }
  return { mult, pot, deltas };
}

export function bookRound(id:string, deltas:{uid:string;delta:number}[], memo = "牌局结算") {
  const path=process.env.CARD_WALLET_DB || '/opt/ssc-ops/ssc_ops.db';
  if(!existsSync(path))throw new Error('棋牌钱包数据库未接入');
  const db=new DatabaseSync(path);
  try{
    db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
    db.exec('CREATE TABLE IF NOT EXISTS poker_round_receipts(id TEXT PRIMARY KEY, receipt TEXT NOT NULL)');
    const prior=db.prepare('SELECT receipt FROM poker_round_receipts WHERE id=?').get(id);
    if(prior){db.exec('COMMIT');return {fresh:false,moves:JSON.parse(String(prior.receipt)) as {uid:string;delta:number;balance:number}[]}}
    const moves=deltas.map(({uid,delta})=>{
      const row=db.prepare('UPDATE users SET poker_balance=round(poker_balance+?,2) WHERE uid=? AND poker_balance+?>=0 RETURNING poker_balance').get(delta,uid,delta);
      if(!row)throw new Error('钱包不存在或余额不足');
      const balance=Number(row.poker_balance);
      if(delta)db.prepare('INSERT INTO flows(uid,kind,amount,balance,ref,memo,ctime) VALUES(?,?,?,?,?,?,?)').run(uid,delta>0?'poker_win':'poker_lose',delta,balance,id,memo,Math.floor(Date.now()/1000));
      return {uid,delta,balance};
    });
    db.prepare('INSERT INTO poker_round_receipts VALUES(?,?)').run(id,JSON.stringify(moves));
    db.exec('COMMIT');return {fresh:true,moves};
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e}finally{db.close()}
}

export async function getBalance(uid: string) {
  return bridge(uid, 'balance', 0);
}
