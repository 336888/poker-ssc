import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Avatar, Modal } from '../src/components/common';
import { PlayingCard } from '../src/components/PlayingCard';
import { GameEntry, HallReturn } from '../src/components/GameEntry';
import { Seat } from '../src/components/Seat';
import { rank, suit, three } from '../public/card-table/rules.js';
import '../src/styles/app.css';
import '../src/lobby-mini.css';
import '../src/styles/table-theme.css';
import './table.css';

const query = new URLSearchParams(location.search);
const requested = query.get('game') === 'nn' ? 'nn' : 'zjh';
const api = import.meta.env.BASE_URL + 'api';
const root = createRoot(document.getElementById('root'));
let pollController = null;
let room = null, token = sessionStorage.getItem('card.auth'), busy = false, timer, message = '', authenticated = false;
const nameOf = game => game === 'nn' ? '牛牛' : '炸金花';
const describe = n => ({id:String(n), deck:0, rank:rank(n), suit:['D','C','H','S'][suit(n)]});
const seatName = seat => seat.name || (seat.seat+1)+'号位';

function Screen(){
  const [picked,setPicked]=useState([]);
  const [leaving,setLeaving]=useState(false);
  const [rules,setRules]=useState(false);
  const s=room, game=s?.game || requested, title=nameOf(game), count=game==='nn'?5:3;
  document.title=title+' · 飞龙娱乐';
  const action=(type,target)=>{ if(pollController)pollController.abort(); return request(type,target,picked); };
  const rulesPanel=rules && <Modal onClose={()=>setRules(false)}><h2>{title}规则</h2>
    <p>每席底注 1，五人成局。等待 8 秒后空席自动补位，并列赢家平分底池，余分按座号分配。</p>
    <p>{game==='nn'?'选三张凑整十，再以剩余两张计牛点。同牛比最大牌，再比花色。超时自动组牛。':'看牌后跟注加倍，比牌同牌时发起者出局。最多 40 次付费行动后摊牌，45 秒未操作自动弃牌。'}</p>
    <button className="btn btn--primary" onClick={()=>setRules(false)}>知道了</button></Modal>;
  const returnToHall=async()=>{
    if(busy)return;
    if(s?.phase==='wait'){
      if(pollController)pollController.abort();
      await request('cancel');
      if(room)return;
    }
    window.location.assign('/');
  };
  if(!s || s.phase==='wait')return <GameEntry title={title} detail="5 人成局 · 每席底注 1" onReturn={returnToHall}>
    {s && <div className="mini-seats">{s.seats.map((v,i)=><div key={i} className={'mini-seat'+(v.kind==='空位'?' mini-seat--empty':'')}>
      <div className="mini-seat__no">{i+1}</div>{v.kind==='空位'?<div className="mini-ava-empty">+</div>:<Avatar name={seatName(v)} kind="human" size={34}/>}
      <div className="mini-seat__name"><span className="mini-name-txt">{v.kind==='空位'?'匹配中…':seatName(v)}{i===s.me && <span className="mini-me">你</span>}</span>
        {typeof v.balance==='number' && <span className="mini-bal">￥{v.balance.toFixed(2)}</span>}</div></div>)}</div>}
    {(message||s)&&<p className="mini-tip" role="status">{message || (s?'正在匹配，约 '+Math.max(0,Math.ceil((s.due-Date.now())/1000))+' 秒后补齐空席':'')}</p>}
    <button className="mini-start" disabled={!authenticated || busy} onClick={()=>action(s?'cancel':'join')}>{s?'取消匹配并退回底注':'开始游戏 · 投入 1 并匹配'}</button>
    <div className="mini-foot"><button className="btn btn--text" onClick={()=>setRules(true)}>规则</button></div>{rulesPanel}</GameEntry>;
  const done=s.phase==='done';
  const btn=(label,type,target,disabled=false)=><button key={type+String(target??'')} className={'btn '+(type==='fold'?'btn--ghost':'btn--primary')} disabled={busy||disabled} onClick={()=>action(type,target)}>{label}</button>;
  const positions=[[17,68],[28,22],[72,22],[83,68]];
  const cost=s.base*(s.seen?2:1);
  return <div className="game five-table"><header className="topbar topbar--game"><HallReturn onReturn={()=>done?returnToHall():setLeaving(true)}/><div className="game__status"><span className="chip chip--mode">{title}</span><span className="chip">五人桌</span></div><button className="btn btn--text" onClick={()=>setRules(true)}>规则</button></header>
    <main className="table"><div className="table__spot"/>{positions.map(([x,y],i)=>{
      const j=(s.me+i+1)%5,v=s.seats[j];return <Seat key={j} player={{name:seatName(v),kind:'human',online:true,balance:v.balance}} isTurn={v.acting} cards={v.active?count:0} rank={null} compact role={null} remaining={null} actionLabel={game==='nn'?'组牛中':'行动中'} seatLabel={!v.active?'已弃牌':v.ready?'已组牛':v.balance==null?'投入 ￥'+v.paid:'已入座'} hideCount={!v.active} style={{left:x+'%',top:y+'%'}}/>})}
      <div className="five-pot">底池 {s.pot}</div></main>
    <section className="me"><div className="me__bar"><div className="me__who"><strong>我 · {seatName(s.seats[s.me])}</strong><span className="me__bal">￥{s.wallet.toFixed(2)}</span></div><span role="status" className="turn-flag">{message || (s.turn?'轮到你':'等待对手')}</span></div>
      <div className="me__actions">{s.turn&&!done&&(game==='nn'?<>{btn('确认三张','manual',undefined,picked.length!==3)}{btn('自动摊牌','auto')}{btn('报无牛','none')}</>:<>{!s.seen&&btn('看牌','look')}{btn('跟注 '+cost,'call')}{s.base<5&&btn('加注 '+((s.base+1)*(s.seen?2:1)),'raise')}{btn('弃牌','fold')}{s.seats.filter(v=>v.seat!==s.me&&v.active).map(v=>btn('比 '+seatName(v)+' · '+cost,'compare',v.seat))}</>)}</div>
      <div className="five-hand">{Array.from({length:count},(_,i)=>{
        const n=s.hand[i],selected=picked.includes(i);return <button key={i} disabled={!s.turn||done||game!=='nn'} aria-pressed={selected} onClick={()=>setPicked(selected?picked.filter(k=>k!==i):picked.length<3?[...picked,i]:picked)}>
        <PlayingCard card={n==null?undefined:describe(n)} size="lg" selected={selected}/></button>})}</div></section>
    {done && <Modal><div className={'result '+(s.delta>0?'result--win':'')}><h2 className="result__title">本局结算</h2><p>{title} · {game==='nn'?'牛点 '+(s.level??0):s.hand.length?['单张','对子','顺子','同花','同花顺','豹子'][three(s.hand)[0]]:''} · 我的净额 {s.delta}</p>
      <ol className="podium">{s.seats.map((v,i)=><li className="podium__row" key={i}><strong>{seatName(v)}{i===s.me?'（你）':''}</strong><span>{v.hand.map(n=>'23456789TJQKA'[rank(n)-2]+'♦♣♥♠'[suit(n)]).join(' ')}</span><b>{v.delta}</b></li>)}</ol>
      {message&&<p role="alert">{message}</p>}<a className="btn btn--ghost" href="/">返回大厅</a> {btn('再匹配一局','join')}</div></Modal>}{rulesPanel}{leaving&&<Modal onClose={()=>setLeaving(false)}><h2>返回大厅？</h2><p>本局继续进行，超时将按本桌规则处理。</p><div className="row-end"><button className="btn btn--ghost" onClick={()=>setLeaving(false)}>取消</button><button className="btn btn--danger" onClick={returnToHall}>确认返回大厅</button></div></Modal>}</div>;
}
function paint(){root.render(<Screen key={room?.id || requested}/>);}
async function request(action,target,trio=[]){
  if(busy)return;
  clearTimeout(timer);
  const polling=action==='state';
  const controller=new AbortController();
  if(polling)pollController=controller;else busy=true;
  message='';if(!polling)paint();
  try{
    const response=await fetch(api+'/card-table',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action,target,trio,game:requested,id:room?.id||sessionStorage.getItem('card.room'),rev:room?.rev}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
    const data=await response.json();if(controller.signal.aborted)return;if(!response.ok)throw Error(data.error||'请求失败');
    if(data.phase==='cancelled'||(action==='state'&&data.phase==='done'&&data.game!==requested)){
      room=null;sessionStorage.removeItem('card.room');message=data.phase==='cancelled'?'已退出匹配，底注已退回':'';
    }else{room=data;sessionStorage.setItem('card.room',data.id)}
  }catch(e){if(!controller.signal.aborted)message=e.message}
  finally{
    if(polling && pollController===controller)pollController=null;
    if(!polling)busy=false;
    if(!controller.signal.aborted){
      paint();
      if(room&&room.phase!=='done')timer=setTimeout(()=>request('state'),1200);
    }
  }
}
async function init(){
  paint();
  const siteToken = localStorage.getItem('token');
  let ticket;
  if(query.has('sso')){
    const [uid, ts, sig] = query.get('sso').split('.');
    ticket = {uid, ts:Number(ts), sig};
  } else if(!token && siteToken){
    const res = await fetch('/api/poker/sso', {
      headers:{Authorization:'Bearer '+siteToken}, cache:'no-store', signal:AbortSignal.timeout(10000)
    });
    const result = await res.json();
    if(!res.ok || result.code !== 0 || !result.data?.sig) throw Error(result.msg || '棋牌登录未完成，请返回大厅重试');
    ticket = result.data;
  }
  if(ticket){
    const {uid,ts,sig} = ticket;
    const res = await fetch(api+'/sso', {method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({uid,ts:Number(ts),sig}),cache:'no-store',signal:AbortSignal.timeout(10000)});
    const identity = await res.json();
    if(!res.ok || !identity.cardToken || identity.uid!==uid) throw Error(identity.error || '棋牌登录失败');
    if(localStorage.getItem('token')!==siteToken) throw Error('登录账号已切换，请返回大厅重试');
    if(sessionStorage.getItem('card.uid')!==uid)sessionStorage.removeItem('card.room');
    token=identity.cardToken;
    sessionStorage.setItem('card.uid',uid);
    sessionStorage.setItem('card.auth',token);
    if(query.has('sso')){
      query.delete('sso');
      history.replaceState(null,'','?'+query);
    }
  }
  if(!token)throw Error('请从主站棋牌大厅登录进入');
  authenticated=true;if(sessionStorage.getItem('card.room'))await request('state');else paint();
}
init().catch(e=>{message=e.message;paint()});
