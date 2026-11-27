import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { runningMultiplier, leaveAmount } from '../src/game/walletFees';
import type { RoomConfig } from '../src/net/protocol';

export function liability(config: Pick<RoomConfig, 'mode'|'seatCount'|'deckCount'>) {
  if (config.mode === 'doudizhu') return { loss: 8, exit: leaveAmount(4, 'landlord') };
  // Each additional deck contributes 44 ranks 3..K; the combined deck keeps three aces and one two.
  const cards = Math.floor((44 * config.deckCount + 4) / config.seatCount);
  const mult = runningMultiplier(6);
  return { loss: cards * mult, exit: leaveAmount(mult) };
}

export function walletFile() { return process.env.CARD_WALLET_DB || '/opt/ssc-ops/ssc_ops.db'; }

function transaction<T>(fn: (db: DatabaseSync) => T): T {
  if (!existsSync(walletFile())) throw new Error('棋牌钱包暂不可用');
  const db = new DatabaseSync(walletFile());
  try {
    db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
    const value = fn(db);
    db.exec('COMMIT');
    return value;
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

export function installCollateral() {
  transaction(db => db.exec(`
    CREATE TABLE IF NOT EXISTS poker_collateral(
      round_id TEXT NOT NULL, uid TEXT NOT NULL, loss INTEGER NOT NULL CHECK(loss>=0),
      exit_fee INTEGER NOT NULL CHECK(exit_fee>=0), PRIMARY KEY(round_id,uid));
    CREATE INDEX IF NOT EXISTS poker_collateral_uid ON poker_collateral(uid);
    CREATE TRIGGER IF NOT EXISTS poker_protect_collateral BEFORE UPDATE OF poker_balance ON users
    WHEN NEW.poker_balance < OLD.poker_balance AND EXISTS(SELECT 1 FROM poker_collateral WHERE uid=OLD.uid)
      AND round(NEW.poker_balance,2) < (SELECT SUM(loss+exit_fee) FROM poker_collateral WHERE uid=OLD.uid)
    BEGIN SELECT RAISE(ABORT,'棋牌余额已用于对局担保'); END;
  `));
}

export function checkSeats(uids: string[], config: RoomConfig, minimum: number, roundId?: string) {
  if (!uids.length) return;
  const {loss, exit} = liability(config);
  const required = Math.max(loss + exit, minimum);
  transaction(db => {
    const balance = db.prepare(`SELECT poker_balance-COALESCE(
      (SELECT sum(loss+exit_fee) FROM poker_collateral WHERE uid=users.uid),0) AS available
      FROM users WHERE uid=? AND status=1`);
    for (const uid of uids) {
      const row = balance.get(uid);
      if (!row) throw new Error('棋牌账户不可用');
      const available = Number(row.available);
      if (!Number.isFinite(available) || available < required)
        throw new Error(`棋牌可用余额不足：本桌需 ${required.toFixed(2)} 元，当前可用 ${available.toFixed(2)} 元`);
      if (roundId) db.prepare('INSERT INTO poker_collateral VALUES(?,?,?,?)').run(roundId,uid,loss,exit);
    }
  });
}

export function clearInactiveHolds(keep: (id: string) => boolean) {
  if (!existsSync(walletFile())) return;
  transaction(db => {
    for (const row of db.prepare('SELECT DISTINCT round_id FROM poker_collateral').all()) {
      const id = String(row.round_id);
      if (!keep(id)) db.prepare('DELETE FROM poker_collateral WHERE round_id=?').run(id);
    }
  });
}

// Called inside the wallet posting transaction, before any balance changes.
export function consumeHold(db: DatabaseSync, id: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='poker_collateral'").get()) return;
  if (id.startsWith('leave:')) {
    const [,code,,started,round,uid] = id.split(':');
    db.prepare('UPDATE poker_collateral SET exit_fee=0 WHERE round_id=? AND uid=?')
      .run([code,round,started].join('-'),uid);
  } else {
    db.prepare('DELETE FROM poker_collateral WHERE round_id=?').run(id);
  }
}
