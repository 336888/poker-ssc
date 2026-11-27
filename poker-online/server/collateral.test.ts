import { expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSeats, clearInactiveHolds, installCollateral, liability } from './collateral';
import { bookRound } from './settle';
import type { RoomConfig } from '../src/net/protocol';

test('one balance cannot guarantee multiple tables or be transferred after dealing', () => {
  const dir=mkdtempSync(join(tmpdir(),'poker-hold-'));
  const previous=process.env.CARD_WALLET_DB;
  const path=join(dir,'wallet.db');
  process.env.CARD_WALLET_DB=path;
  const db=new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE users(uid TEXT PRIMARY KEY,status INTEGER,poker_balance REAL);
      CREATE TABLE flows(uid,kind,amount,balance,ref,memo,ctime);
      INSERT INTO users VALUES('alice',1,1088),('bob',1,1087.99)`);
    const config={mode:'paodekuai',deckCount:1,seatCount:3} as RoomConfig;
    installCollateral();
    expect(liability(config)).toEqual({loss:1024,exit:64});
    expect(liability({...config,mode:'doudizhu'})).toEqual({loss:8,exit:8});
    expect(()=>checkSeats(['alice','bob'],config,50,'TABLE1-1-100')).toThrow(/余额不足/);
    expect(db.prepare('SELECT count(*) n FROM poker_collateral').get()?.n).toBe(0);
    checkSeats(['alice'],config,50,'TABLE1-1-100');
    expect(()=>checkSeats(['alice'],config,50,'OTHER1-1-101')).toThrow(/余额不足/);
    expect(()=>db.exec("UPDATE users SET poker_balance=poker_balance-0.01 WHERE uid='alice'")).toThrow(/对局担保/);
    bookRound('leave:TABLE1:10:100:1:alice',[{uid:'alice',delta:-64}],'中途退桌');
    const moves=[{uid:'alice',delta:-1024}];
    expect(bookRound('TABLE1-1-100',moves).fresh).toBe(true);
    expect(bookRound('TABLE1-1-100',moves).fresh).toBe(false);
    expect(db.prepare("SELECT poker_balance FROM users WHERE uid='alice'").get()?.poker_balance).toBe(0);
    const d={...config,mode:'doudizhu'} as RoomConfig;
    checkSeats(['bob'],d,50,'TABLE2-1-101');
    clearInactiveHolds(()=>true);
    expect(db.prepare('SELECT count(*) n FROM poker_collateral').get()?.n).toBe(1);
    clearInactiveHolds(()=>false);
    expect(db.prepare('SELECT count(*) n FROM poker_collateral').get()?.n).toBe(0);
  } finally {
    db.close(); if(previous===undefined) delete process.env.CARD_WALLET_DB; else process.env.CARD_WALLET_DB=previous;
    rmSync(dir,{force:true,recursive:true});
  }
});
