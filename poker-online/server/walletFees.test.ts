import { expect, it } from 'vitest';
import { leaveAmount, leaveMultiplier } from '../src/game/walletFees';
import { calcDeltas } from './settle';

it('跑得快退桌与结算使用相同的炸弹倍数，斗地主保留角色倍数', () => {
  for (const bombs of [0, 1, 3, 7]) {
    const quote = leaveMultiplier('paodekuai', bombs, [16, 12, 3]);
    expect(quote).toBe(calcDeltas([], 1, 0, 'paodekuai', bombs).mult);
    expect(leaveAmount(quote)).toBe(2 ** Math.min(6, bombs));
  }
  expect(leaveAmount(leaveMultiplier('doudizhu', 0, [16, 12, 3]), 'landlord')).toBe(8);
});

import { Store } from './db';
import { bookRound } from './settle';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

it('退桌流水相同只扣一次，跨重启保留首次金额，下一局独立扣款', () => {
  const dir = mkdtempSync(join(tmpdir(),'leave-fee-'));
  const wallet = join(dir,'wallet.db'), db = new DatabaseSync(wallet);
  const file = join(dir,'poker.db');
  let store = new Store(file);
  vi.stubEnv('CARD_WALLET_DB',wallet);
  try {
    db.exec("CREATE TABLE users(uid TEXT PRIMARY KEY,poker_balance REAL); CREATE TABLE flows(uid,kind,amount,balance,ref,memo,ctime); INSERT INTO users VALUES('alice',10)");
    const id = 'leave:test:1:10:1:alice';
    const amount = store.queueLeaveFee(id,'alice',2);
    expect(bookRound(id,[{uid:'alice',delta:-amount}],'中途退桌').fresh).toBe(true);
    store.close();
    store = new Store(file);
    expect(store.queueLeaveFee(id,'alice',4)).toBe(2);
    expect(bookRound(id,[{uid:'alice',delta:-2}],'中途退桌').fresh).toBe(false);
    store.completeLeaveFee(id);
    bookRound('leave:test:1:20:2:alice',[{uid:'alice',delta:-1}],'中途退桌');
    expect(db.prepare('SELECT poker_balance FROM users').get()?.poker_balance).toBe(7);
    expect(db.prepare('SELECT count(*) n FROM flows').get()?.n).toBe(2);
  } finally {
    store.close();db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});
  }
});
