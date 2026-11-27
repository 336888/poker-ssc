const {test}=process.env.VITEST ? await import('vitest') : await import('node:test');
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {cardTables} from './cardTables.js';

test('五人匹配、单次扣款、断线恢复、机器人补位及超时结算',()=>{
  const dir=mkdtempSync(join(tmpdir(),'duel-')), path=join(dir,'wallet.db');
  const db=new DatabaseSync(path);
  db.exec("CREATE TABLE users(uid TEXT PRIMARY KEY,poker_balance REAL,status INTEGER);CREATE TABLE flows(uid,kind,amount,balance,ref,memo,ctime);INSERT INTO users VALUES('a',100,1),('b',100,1),('c',100,1),('d',100,1),('e',100,1)");
  let now=10000;
  const open=()=>cardTables(path,()=>({botRate:.7,minBal:50}),()=>now);
  let service=open();
  const send=(uid,action,r={},game='zjh')=>service.request(uid,{action,id:r.id,rev:r.rev,game});
  try{
    for(const game of ['zjh','nn']){
      const ids=['a','b','c','d','e'];
      const entries=ids.map(uid=>send(uid,'join',{},game));
      assert.equal(new Set(entries.map(s=>s.id)).size,1);
      assert.deepEqual(entries[0].seats.map(s=>s.name),['a',null,null,null,null]);
      assert.equal(entries[0].seats[0].balance,entries[0].wallet);
      let r=entries[4];
      assert.deepEqual(r.seats.map(s=>s.name),ids);
      for(const seat of r.seats) assert.equal(seat.balance,db.prepare('SELECT poker_balance FROM users WHERE uid=?').get(seat.name).poker_balance);
      assert.equal(r.phase,'play');
      assert.deepEqual(service.activeCounts().map(row=>[row.game,row.phase,row.count]),[[game,'play',1]]);
      let moves=0;
      while(r.phase==='play'){
        const actor=r.seats.find(s=>s.acting).seat;
        const opp=r.seats.find(s=>s.active&&s.seat!==actor).seat;
        const view=send(ids[actor],'state',r);
        assert.ok(view.seats.every(s=>s.hand.length===0));
        const action=game==='nn'?'auto':'compare';
        const body={action,id:r.id,rev:r.rev,target:opp};
        r=service.request(ids[actor],body);
        const count=db.prepare('SELECT COUNT(*) n FROM flows').get().n;
        service.request(ids[actor],body);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM flows').get().n,count);
        assert.ok(++moves<=5);
      }
      assert.equal(moves,game==='nn'?5:4);
      assert.equal(new Set(r.seats.flatMap(s=>s.hand)).size,game==='nn'?25:15);
      assert.equal(db.prepare('SELECT sum(poker_balance) AS n FROM users').get().n,500);
    }
    let a=send('a','join');assert.equal(service.activeCounts()[0].phase,'wait');let b=send('b','join');assert.equal(send('b','cancel',b).phase,'cancelled');
    a=send('a','join');now+=8100;service.close();service=open();service.resume();
    a=send('a','state',a);assert.equal(a.seats.filter(s=>s.kind==='机器人').length,4);
    for(let i=0;i<55&&a.phase!=='done';i++){now+=46000;service.tick();a=send('a','state',a)}
    assert.equal(a.phase,'done');assert.equal(typeof a.delta,'number');
    assert.throws(()=>send('c','state',a));
  }finally{service.close();db.close();rmSync(dir,{recursive:true,force:true})}
});
