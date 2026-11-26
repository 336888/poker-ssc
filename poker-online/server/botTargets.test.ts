import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from './app';
import {gameRate,hardProb,useTargets} from './rtcfg';

it('管理员分游戏保存，非法批次整体拒绝，重启恢复',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bot-targets-'));
 const opts={dbFile:join(dir,'poker.db'),host:'127.0.0.1',port:0,adminPassword:'test-only',quiet:true};
 let app=await createApp(opts);
 let token='';
 async function call(path:string,body?:object){
   return fetch('http://127.0.0.1:'+app.port+'/api/admin/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
 }
 try{
   expect((await call('bot-targets')).status).toBe(401);
   token=(await (await call('login',{password:'test-only'})).json()).token;
   const data={nn:75,zjh:52,paodekuai:null,doudizhu:50};
   expect((await call('bot-targets',data)).status).toBe(204);
   expect((await call('bot-targets',{...data,nn:101})).status).toBe(400);
   expect(gameRate('nn')).toBe(.75);expect(gameRate('zjh')).toBe(.52);expect(hardProb('doudizhu')).toBe(0);
   await app.close();app=await createApp(opts);
   token=(await (await call('login',{password:'test-only'})).json()).token;
   expect((await (await call('bot-targets')).json()).targets).toEqual({nn:75,zjh:52,doudizhu:50});
 }finally{await app.close();useTargets({});rmSync(dir,{recursive:true,force:true})}
});
