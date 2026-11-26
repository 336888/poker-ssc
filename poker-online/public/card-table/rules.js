export const rank = card => card % 13 + 2;
export const suit = card => Math.floor(card / 13);
export const point = card => rank(card) === 14 ? 1 : Math.min(rank(card), 10);
export function compare(a,b) {
  for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return Math.sign(a[i]-b[i]);
  return 0;
}
export function three(cards) {
  const r=cards.map(rank).sort((a,b)=>b-a);
  const flush=cards.every(c=>suit(c)===suit(cards[0]));
  const run=r[0]-r[1]===1 && r[1]-r[2]===1 ? r[0] : r.join() === '14,3,2' ? 3 : 0;
  if(r[0]===r[2]) return [5,r[0]];
  if(flush && run) return [4,run];
  if(flush) return [3,...r];
  if(run) return [2,run];
  if(r[0]===r[1]) return [1,r[0],r[2]];
  if(r[1]===r[2]) return [1,r[1],r[0]];
  return [0,...r];
}
export function bull(cards) {
  const total=cards.reduce((s,c)=>s+point(c),0);
  for(let i=0;i<3;i++) for(let j=i+1;j<4;j++) for(let k=j+1;k<5;k++) {
    if((point(cards[i])+point(cards[j])+point(cards[k]))%10===0)
      return {level:total%10||10, trio:[i,j,k]};
  }
  return {level:0,trio:[]};
}
export function bullScore(cards) {
  const strength=c=>(rank(c)===14?1:rank(c))*4+suit(c);
  return [bull(cards).level,Math.max(...cards.map(strength))];
}
export function deal(n) {
  const deck=Array.from({length:52},(_,i)=>i);
  for(let i=51;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1));
    [deck[i],deck[j]]=[deck[j],deck[i]];
  }
  return [deck.slice(0,n),deck.slice(n,2*n)];
}
