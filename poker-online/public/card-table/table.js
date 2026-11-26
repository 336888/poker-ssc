import {rank,suit,three} from './rules.js';
const $=id=>document.getElementById(id);
const q=new URLSearchParams(location.search);
const game=q.get('game')==='nn'?'nn':'zjh';
const title=g=>g==='nn'?'牛牛':'炸金花';
const types=['单张','对子','顺子','同花','同花顺','豹子'];
const api='/poker/api';
let token=sessionStorage.getItem('card.auth'),state=null,busy=false,timer,picks=[];
function note(s){$('status').textContent=s}
function buttons(items){
  $('actions').replaceChildren(...items.map(([name,fn])=>{
    const b=document.createElement('button');b.className='btn--primary';b.textContent=name;b.onclick=fn;return b;
  }));
}
function cards(id,hand,selectable){
  const n=(state?.game||game)==='nn'?5:3;
  $(id).replaceChildren(...Array.from({length:n},(_,k)=>{
    const c=hand?.[k],b=document.createElement('button');
    b.className='card '+(c==null?'back':[0,2].includes(suit(c))?'red':'');
    b.textContent=c==null?'◆':'23456789TJQKA'[rank(c)-2].replace('T','10')+'♦♣♥♠'[suit(c)];
    b.disabled=!selectable;
    b.classList.toggle('picked',picks.includes(k)&&selectable);
    b.onclick=()=>{if(picks.includes(k))picks=picks.filter(x=>x!==k);else if(picks.length<3)picks.push(k);render()};
    return b;
  }));
}
function render(){
  if(!state)return;
  const s=state;
  document.documentElement.classList.add('in-game');
  $('marque').textContent=title(s.game);
  document.querySelector('h1').textContent=title(s.game);
  document.querySelector('header span').textContent=s.seats.length+'人桌';
  const relative=[2,3,1,4];
  $('self').textContent='我 · '+(s.me+1)+'号位';
  $('away').replaceChildren(...relative.map(offset=>{
    const i=(s.me+offset)%s.seats.length, seat=s.seats[i];
    const b=document.createElement('div');
    b.className='seat'+(seat.acting?' acting':'');
    const name=document.createElement('strong'), info=document.createElement('small');
    name.textContent=(i+1)+'号位';
    info.textContent=s.phase==='done'?'净额 '+(seat.delta??0):seat.kind==='空位'?'空位':seat.acting?'行动中':!seat.active?'已出局':seat.ready?'已组牛':'已入座';
    b.append(name,info);
    if(seat.hand.length){
      const hand=document.createElement('small');
      hand.textContent=seat.hand.map(c=>'23456789TJQKA'[rank(c)-2].replace('T','10')+'♦♣♥♠'[suit(c)]).join(' ');
      b.append(hand);
    }
    return b;
  }));
  $('round').textContent='棋牌余额 '+s.wallet.toFixed(2);
  $('pot').textContent='底池 '+s.pot;
  cards('home',s.hand,s.turn && s.phase==='play' && s.game==='nn');

  if(s.phase==='done'){
    note('结算完成 · 本局 '+(s.delta>0?'+':'')+s.delta+(s.game==='zjh'&&s.hand.length?' · '+types[three(s.hand)[0]]:s.level!=null?' · 牛点 '+s.level:''));
    buttons([['再匹配一局',()=>{picks=[];request('join')}]]);
  }else if(s.phase==='wait'){
    note('优先匹配真人，约 '+Math.max(0,Math.ceil((s.due-Date.now())/1000))+' 秒后机器人补位');
    buttons([['取消并退回底注',()=>request('cancel')]]);
  }else if(!s.turn){note('等待对手操作');buttons([])}
  else if(s.game==='nn'){
    note('轮到你组牛，超时自动摊牌。');
    buttons([['确认三张',()=>request('manual')],['自动摊牌',()=>request('auto')],['报无牛',()=>request('none')]]);
  }else{
    note('轮到你 · 超时弃牌');
    const cost=s.base*(s.seen?2:1);
    const actions=[['跟注 '+cost,'call'],['弃牌','fold']];
    if(!s.seen)actions.unshift(['看牌','look']);
    if(s.base<5)actions.splice(-1,0,['加注 '+(s.base+1)*(s.seen?2:1),'raise']);
    buttons([...actions.map(([n,a])=>[n,()=>request(a)]),...s.seats.filter(v=>v.seat!==s.me&&v.active).map(v=>['比 '+(v.seat+1)+'号 · '+cost,()=>request('compare',v.seat)])]);
  }
}
async function request(action,target){
  if(busy)return;
  clearTimeout(timer);busy=true;
  try{
    const id=state?.id||sessionStorage.getItem('card.room');
    const res=await fetch(api+'/card-table',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({id,game,rev:state?.rev,action,target,trio:picks}),signal:AbortSignal.timeout(10000)});
    const data=await res.json();
    if(!res.ok)throw Error(data.error||'牌局暂不可用');
    if(data.phase==='cancelled'){
      state=null;$('self').textContent='';document.documentElement.classList.remove('in-game');sessionStorage.removeItem('card.room');$('away').replaceChildren();$('home').replaceChildren();$('round').textContent='';$('pot').textContent='';
      note('已退出匹配，底注已退回');buttons([['重新匹配',()=>request('join')]]);return;
    }
    state=data;sessionStorage.setItem('card.room',data.id);render();
  }catch(e){
    note(e.message);
    if(!state)buttons([['恢复牌局',()=>request('state')],['匹配',()=>request('join')]]);
  }finally{busy=false;if(state&&state.phase!=='done')timer=setTimeout(()=>request('state'),1200)}
}
async function init(){
  $('marque').textContent=title(game);
  document.title=document.querySelector('h1').textContent=title(game);
  document.querySelector('header span').textContent='五人联机';
  $('rules').textContent='每方底注 1，最终并列按分均分底池，余分依座号分配，赢家收取底池。满五人立即开局，8 秒后空席由机器人补齐。炸金花暗牌按底价，看牌后加倍，可指定对手比牌，同牌发起者出局；最多 40 次付费行动后摊牌；45 秒未操作自动弃牌。牛牛三张凑整十，同牛比最大牌（A 最小），再比花色；超时自动组牛。';
  if(q.has('sso')){
    const [uid,ts,sig]=q.get('sso').split('.');
    const res=await fetch(api+'/sso',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uid,ts:Number(ts),sig})});
    const d=await res.json();if(!res.ok||!d.cardToken)throw Error(d.error||'钱包认证失败，请返回大厅重试');
    if(sessionStorage.getItem('card.uid')!==uid)sessionStorage.removeItem('card.room');
    sessionStorage.setItem('card.uid',uid);
    token=d.cardToken;sessionStorage.setItem('card.auth',token);q.delete('sso');history.replaceState(null,'','?'+q);
  }
  if(!token)throw Error('请从主站棋牌大厅登录进入');
  if(sessionStorage.getItem('card.room')){
    await request('state');if(state&&state.phase!=='done')return;
    if(state?.game===game)return;
    state=null;
  }
  note('每席底注 1，胜方收取底池。');buttons([['投入 1 并匹配',()=>request('join')]]);
}
init().catch(e=>note(e.message));
