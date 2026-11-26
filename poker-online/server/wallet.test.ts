import {expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bookRound,calcDeltas} from './settle';
import {createApp} from './app';

it('整局记账失败回滚，重放同一回执不重复扣款',()=>{
  const dir=mkdtempSync(join(tmpdir(),'poker-book-'));
  const path=join(dir,'wallet.db'), before=process.env.CARD_WALLET_DB;
  process.env.CARD_WALLET_DB=path;
  const db=new DatabaseSync(path);
  try{
    db.exec("CREATE TABLE users(uid TEXT PRIMARY KEY,poker_balance REAL);CREATE TABLE flows(uid,kind,amount,balance,ref,memo,ctime);INSERT INTO users VALUES('a',10),('b',10)");
    const moves=(n:number)=>[{uid:'a',delta:n},{uid:'b',delta:-n}];
    expect(()=>bookRound('r',moves(12))).toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM flows').get()?.n).toBe(0);
    expect(db.prepare("SELECT poker_balance FROM users WHERE uid='a'").get()?.poker_balance).toBe(10);
    expect(bookRound('r',moves(4)).fresh).toBe(true);
    expect(bookRound('r',moves(4)).fresh).toBe(false);
    expect(db.prepare('SELECT poker_balance FROM users ORDER BY uid').all().map(r=>r.poker_balance)).toEqual([14,6]);
  }finally{db.close();if(before===undefined)delete process.env.CARD_WALLET_DB;else process.env.CARD_WALLET_DB=before;rmSync(dir,{recursive:true,force:true})}
});
it('斗地主十五张触发四倍，跑得快炸弹计入底分',()=>{
  const rows=[{uid:'a',name:'A',rank:1,remaining:0,role:'landlord'},{uid:'b',name:'B',rank:2,remaining:5,role:'farmer'},{uid:'c',name:'C',rank:3,remaining:15,role:'farmer'}];
  expect(calcDeltas(rows,1,0,'doudizhu').mult).toBe(4);
  expect(calcDeltas(rows.slice(0,2),1,0,'paodekuai',1).deltas.find(x=>x.uid==='a')?.delta).toBe(10);
});
it('建房和入房需要凭据绑定钱包账号',async()=>{
 const app=await createApp({port:0,host:'127.0.0.1',dbFile:':memory:',quiet:true});
 const post=(path:string,body:object)=>fetch('http://127.0.0.1:'+app.port+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
   expect((await post('rooms',{uid:'alice',hostName:'测试'})).status).toBe(401);
   const guest=await post('rooms',{hostName:'测试'});expect(guest.status).toBe(200);
   const {code}=await guest.json();
   expect((await post('rooms/'+code+'/join',{name:'用户',uid:'alice'})).status).toBe(401);
 }finally{await app.close()}
});
