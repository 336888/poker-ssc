export function cardTables(path:string,config:(game:"nn"|"zjh")=>{botRate:number,minBal:number,names?:string[]}):{
  request(uid:string,body:Record<string,unknown>,admit?:()=>void):unknown;
  activeCounts():{game:"nn"|"zjh",phase:"wait"|"play",count:number}[];
  tick():void; resume():void; close():void;
};
