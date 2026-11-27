import { DatabaseSync } from 'node:sqlite';
import { bookRound, calcDeltas } from '../poker-online/server/settle';
import type { GameRecord } from '../poker-online/src/net/adminHistory';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export function reconcileRounds(gamePath: string, walletPath: string) {
  const game = new DatabaseSync(gamePath);
  let recovered = 0, review = 0;
  try {
    game.exec('PRAGMA busy_timeout=2000');
    const pending = game.prepare("SELECT id FROM history WHERE json_extract(record,'$.walletStatus')='pending'").all();
    if (!pending.length) return {recovered, review};
    const wallet = new DatabaseSync(walletPath, {readOnly:true});
    try {
      for (const item of pending) {
        game.exec('BEGIN IMMEDIATE');
        try {
          const stored = game.prepare('SELECT record FROM history WHERE id=?').get(item.id);
          if (!stored) continue;
          const record: GameRecord = JSON.parse(String(stored.record));
          if (record.walletStatus !== 'pending') continue;
          const moves = record.walletMoves || [];
          const expected = calcDeltas(record.settlement.map(r=>({uid:r.playerId,...r})),1,0,record.mode,record.bombs).deltas;
          if (!moves.length || record.id !== item.id || new Set(moves.map(m=>m.uid)).size !== moves.length ||
              !moves.every(m => record.players.some(p=>p.id===m.uid && p.kind==='human') &&
                expected.some(e=>e.uid===m.uid && e.delta===m.delta))) { review++; continue; }
          const hasTable = wallet.prepare("SELECT 1 FROM sqlite_master WHERE name='poker_round_receipts' AND type='table'").get();
          const prior = hasTable && wallet.prepare('SELECT receipt FROM poker_round_receipts WHERE id=?').get(record.id);
          let receipt;
          if (prior) receipt = JSON.parse(String(prior.receipt));
          else if (/database (?:is locked|is busy)|SQLITE_BUSY/i.test(record.walletReason || '')) {
            // Use the same transaction and unique round identifier as normal settlement.
            try {
              receipt = bookRound(record.id,moves).moves;
            } catch (error) {
              if (error instanceof Error && error.message === '钱包不存在或余额不足') {
                record.walletReason = error.message;
                game.prepare('UPDATE history SET record=? WHERE id=?').run(JSON.stringify(record),record.id);
                game.exec('COMMIT'); review++; continue;
              }
              throw error;
            }
          } else { review++; continue; }
          if (!Array.isArray(receipt) || receipt.length !== moves.length || !moves.every(m=>
              receipt.some(r=>r.uid===m.uid && r.delta===m.delta && Number.isFinite(r.balance)))) { review++; continue; }
          record.walletMoves=receipt; record.walletStatus='booked'; delete record.walletReason;
          for (const row of record.settlement) Object.assign(row,{delta:expected.find(m=>m.uid===row.playerId)?.delta??0});
          game.prepare('UPDATE history SET record=? WHERE id=?').run(JSON.stringify(record),record.id);
          game.exec('COMMIT'); recovered++;
        } catch (e) {
          review++;
          if (!/钱包不存在或余额不足|database is locked/.test(String(e))) console.error('整局核对失败',String(e));
        } finally { if (game.isTransaction) game.exec('ROLLBACK'); }
      }
    } finally { wallet.close(); }
    return {recovered,review};
  } finally { game.close(); }
}

if (process.argv.includes('--service')) {
  const pid=Number(execFileSync('systemctl',['show','-p','MainPID','--value','poker.service'],{encoding:'utf8'}).trim());
  if (pid>0) {
    const proc='/proc/'+pid;
    const env=new Map(readFileSync(proc+'/environ','utf8').split('\0').map(v=>{const i=v.indexOf('='); return [v.slice(0,i),v.slice(i+1)] as const;}));
    const root=realpathSync(proc+'/cwd');
    const wallet=resolve(root,env.get('CARD_WALLET_DB')||'/opt/ssc-ops/ssc_ops.db');
    process.env.CARD_WALLET_DB=wallet;
    console.log('round reconciliation',reconcileRounds(resolve(root,env.get('DATA_DIR')||'data','poker.db'),wallet));
  }
}
