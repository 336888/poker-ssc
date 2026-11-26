export function cardTables(path:string,config:(game:"nn"|"zjh")=>{botRate:number,minBal:number}):{
  request(uid:string,body:Record<string,unknown>):unknown;
  tick():void; resume():void; close():void;
};
