// Store the hand and its wallet entries in one SQLite transaction.
import { DatabaseSync } from 'node:sqlite';
import { randomInt, randomUUID } from 'node:crypto';
import { three, bull, bullScore, compare, point } from '../public/card-table/rules.js';

function assignBotNames(users, names = []) {
  const pool = [...new Set(names)].filter(name => !users.includes(name));
  return users.map(uid => uid != null || !pool.length ? null : pool.splice(randomInt(pool.length), 1)[0]);
}

export function cardTables(path, config, clock = Date.now) {
  let db;
  function open() {
    if (db) return;
    const next = new DatabaseSync(path, {open:false});
    // Opening an existing wallet database must never initialize an empty wallet.
    next.open();
    try {
      next.exec('PRAGMA busy_timeout=3000');
      next.prepare('SELECT poker_balance FROM users LIMIT 0').all();
      next.exec("CREATE TABLE IF NOT EXISTS card_duels(id TEXT PRIMARY KEY, game TEXT, phase TEXT, due INTEGER, a TEXT, b TEXT, state TEXT); CREATE INDEX IF NOT EXISTS card_duels_due ON card_duels(phase,due); CREATE INDEX IF NOT EXISTS card_duels_a ON card_duels(a,phase); CREATE INDEX IF NOT EXISTS card_duels_b ON card_duels(b,phase)");
      db=next;
    } catch(e){next.close();throw e}
  }
  function money(uid, delta, r, memo) {
    if(uid===null || !delta) return;
    const row=db.prepare('UPDATE users SET poker_balance=round(poker_balance+?,2) WHERE uid=? AND poker_balance+?>=0 RETURNING poker_balance').get(delta,uid,delta);
    if(!row) throw new Error('棋牌余额不足');
    db.prepare('INSERT INTO flows(uid,kind,amount,balance,ref,memo,ctime) VALUES(?,?,?,?,?,?,?)').run(uid,delta>0?'poker_win':'poker_lose',delta,row.poker_balance,r.id,memo,Math.floor(clock()/1000));
  }
  function save(r) {
    db.prepare('INSERT OR REPLACE INTO card_duels VALUES(?,?,?,?,?,?,?)').run(r.id,r.game,r.phase,r.due,r.users[0],r.users[1],JSON.stringify(r));
  }
  function get(sql,...args){const row=db.prepare(sql).get(...args);return row && JSON.parse(row.state)}
  function begin(r){
    r.botNames=assignBotNames(r.users,config(r.game).names);
    r.phase='play';
    r.paid=r.users.map(()=>1);
    r.active=r.users.map(()=>true);
    const deck=Array.from({length:52},(_,i)=>i);
    for(let i=51;i>0;i--){const j=randomInt(i+1);[deck[i],deck[j]]=[deck[j],deck[i]]}
    const n=r.game==='zjh'?3:5;
    r.hands=r.users.map((_,i)=>deck.slice(i*n,(i+1)*n));
    r.turn=randomInt(r.users.length);r.levels=r.users.map(()=>null);r.seen=r.users.map(()=>false);r.base=1;r.steps=0;
    r.strength=Math.max(0,Math.min(1,(config(r.game).botRate-.5)/.25));deadline(r);
  }
  function deadline(r){r.due=clock()+(r.users[r.turn]===null?1200:45000)}
  function finish(r,winners){
    const cents=r.paid.reduce((a,b)=>a+b,0)*100;
    const payouts=r.paid.map((paid,i)=>{
      if(!winners.length)return paid;
      const k=winners.indexOf(i);
      if(k<0)return 0;
      return (Math.floor(cents/winners.length)+(k<cents%winners.length?1:0))/100;
    });
    r.delta=payouts.map((x,i)=>Math.round((x-r.paid[i])*100)/100);
    r.users.forEach((uid,i)=>money(uid,payouts[i],r,'牌局结算'));
    r.phase='done';r.due=0;
  }
  function contenders(r){return r.users.map((_,i)=>i).filter(i=>r.active?.[i]!==false)}
  function showdown(r){
    const scores=r.hands.map((h,i)=>r.game==='zjh'?three(h):[r.levels[i],bullScore(h)[1]]);
    const live=contenders(r);
    const best=live.reduce((a,b)=>compare(scores[a],scores[b])>=0?a:b);
    finish(r,live.filter(i=>compare(scores[i],scores[best])===0));
  }
  function move(r,i,act,trio,target){
    r.active??=r.users.map(()=>true);
    if(r.game==='nn'){
      let level=bull(r.hands[i]).level;
      if(act==='manual'){
        if(!Array.isArray(trio)||trio.length!==3||new Set(trio).size!==3||!trio.every(k=>Number.isInteger(k)&&k>=0&&k<5)||trio.reduce((v,k)=>v+point(r.hands[i][k]),0)%10)throw new Error('请选择三张能凑整十的牌');
      }else if(act==='none'){level=0}
      else if(act!=='auto')throw new Error('操作无效');
      r.levels[i]=level;
      if(r.levels.every(v=>v!==null)){showdown(r);return}
    }else{
      if(act==='look'&&!r.seen[i]){r.seen[i]=true;return}
      if(act==='fold'){r.active[i]=false}else{
      if(!['raise','call','compare'].includes(act)||act==='raise'&&r.base>=5)throw new Error('操作无效');
      if(act==='raise')r.base++;
      const cost=r.base*(r.seen[i]?2:1);
      money(r.users[i],-cost,r,'牌局投入');r.paid[i]+=cost;
      if(act==='compare'){
        const opponents=contenders(r).filter(k=>k!==i);
        const k=target??opponents[0];
        if(!opponents.includes(k))throw new Error('请选择仍在局内的对手');
        if(r.users.length===2){showdown(r);return}
        r.active[compare(three(r.hands[i]),three(r.hands[k]))>0?k:i]=false;
      }
      if(++r.steps>=8*r.users.length){showdown(r);return}
      }
      const live=contenders(r);
      if(live.length===1){finish(r,live);return}
    }
    do{r.turn=(r.turn+1)%r.users.length}while(!r.active[r.turn]);deadline(r);
  }
  function advance(r){
    if(r.phase==='wait'){begin(r);return}
    const i=r.turn;
    if(r.users[i]!==null){move(r,i,r.game==='nn'?'auto':'fold');return}
    const smart=randomInt(10000)<r.strength*10000;
    if(r.game==='nn'){move(r,i,smart||randomInt(5)!==0?'auto':'none');return}
    r.seen[i]=true;
    const score=three(r.hands[i]);
    const weak=score[0]===0 && score[1]<12;
    const act=smart && weak && r.steps>=2?'fold':smart && score[0]>0 && r.base<5 && r.steps<6?'raise':r.steps>=4?'compare':'call';
    move(r,i,act);
  }
  function tx(fn){open();db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v}catch(e){db.exec('ROLLBACK');throw e}}
  function tick(){
    if(!db)return;
    tx(()=>{for(const row of db.prepare("SELECT state FROM card_duels WHERE phase IN ('wait','play') AND due<=? LIMIT 100").all(clock())){
      const r=JSON.parse(row.state);advance(r);r.rev++;save(r);
    }});
  }
  function request(uid,body,admit){
    return tx(()=>{
      let r;
      if(body.action==='join'){
        if(!['zjh','nn'].includes(body.game))throw new Error('游戏无效');
        r=get("SELECT state FROM card_duels WHERE phase IN ('wait','play') AND EXISTS(SELECT 1 FROM json_each(state,'$.users') WHERE value=?) LIMIT 1",uid);
        if(!r){
          admit?.();
          const holds=db.prepare("SELECT 1 FROM sqlite_master WHERE name='poker_collateral' AND type='table'").get();
          const held=holds ? db.prepare('SELECT coalesce(sum(loss+exit_fee),0) AS total FROM poker_collateral WHERE uid=?').get(uid).total : 0;
          const user=db.prepare('SELECT poker_balance,status FROM users WHERE uid=?').get(uid);
          if(!user||user.status!==1||user.poker_balance-held<Math.max(1,config().minBal))throw new Error('账户不可入场或棋牌余额不足');
          r=get("SELECT state FROM card_duels WHERE game=? AND phase='wait' AND json_array_length(state,'$.users')=5 AND due>? ORDER BY due LIMIT 1",body.game,clock());
          if(!r)r={id:randomUUID(),users:Array(5).fill(null),game:body.game,phase:'wait',due:clock()+8000,rev:0,paid:Array(5).fill(0)};
          const seat=r.users.indexOf(null);
          r.users[seat]=uid;r.paid[seat]=1;r.rev++;
          money(uid,-1,r,'匹配底注');
          if(!r.users.includes(null))begin(r);
          save(r);
        }
      }else{
        r=get('SELECT state FROM card_duels WHERE id=?',String(body.id||''));
        if(!r || !r.users.includes(uid))throw new Error('牌局不存在');
        if(body.action!=='state' && body.rev===r.rev && r.phase!=='done'){
          if(clock()>=r.due){advance(r)}
          else if(r.phase==='wait'&&body.action==='cancel'){
            const seat=r.users.indexOf(uid);
            money(uid,r.paid[seat],r,'取消匹配退款');r.users[seat]=null;r.paid[seat]=0;
            if(r.users.every(u=>u===null)){r.phase='done';r.due=0}
            r.rev++;save(r);
            return {id:r.id,game:r.game,phase:'cancelled'};
          }
          else if(r.phase==='play'&&r.users[r.turn]===uid){move(r,r.turn,body.action,body.trio,body.target)}
          else throw new Error('请等待对手');
          r.rev++;save(r);
        }
      }
      const me=r.users.indexOf(uid), reveal=r.phase==='done'&&Boolean(r.hands);
      const wallets=db.prepare('SELECT uid,poker_balance FROM users WHERE uid IN (SELECT value FROM json_each(?))').all(JSON.stringify(r.users));
      const balances=new Map(wallets.map(row=>[row.uid,row.poker_balance]));
      if (r.phase==='play' && !r.botNames) {
      r.botNames=assignBotNames(r.users,config(r.game).names);
      save(r);
    }
      return {id:r.id,rev:r.rev,game:r.game,phase:r.phase,due:r.due,me,seats:r.users.map((u,i)=>({
          name:u ?? (r.phase==='wait'?null:(r.botNames?.[i] || '机器人')),balance:balances.get(u) ?? null,
          seat:i,kind:u?'真人':r.phase==='wait'?'空位':'机器人',active:r.active?.[i]!==false,
          acting:r.phase==='play'&&r.turn===i,paid:r.paid[i],delta:r.delta?.[i],
          hand:reveal?r.hands[i]:[],handCount:r.hands?.[i]?.length ?? 0,ready:r.levels?.[i]!=null
        })),
        turn:r.turn===me,base:r.base,seen:r.seen?.[me],pot:r.paid.reduce((a,b)=>a+b,0),delta:r.delta?.[me],level:r.levels?.[me],
        wallet:balances.get(uid),
        hand:r.hands&&(reveal||r.game==='nn'||r.seen[me])?r.hands[me]:[]};
    });
  }
  function activeCounts() {
    open();
    return db.prepare("SELECT game,phase,count(*) AS count FROM card_duels WHERE phase IN ('wait','play') GROUP BY game,phase").all();
  }
  return {request,tick,activeCounts,resume(){open();tick()},close(){db?.close();db=null}};
}
