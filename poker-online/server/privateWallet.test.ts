import {expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHmac} from 'node:crypto';
import {Store} from './db';
import {createApp} from './app';
import * as settle from './settle';

it('旧管理员凭据迁移，单点票据只兑换一次，个人数据仅本人可读',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'poker-auth-'));
  const opts={host:'127.0.0.1',port:0,dbFile:join(dir,'poker.db'),quiet:true};
  const store=new Store(opts.dbFile);
  store.setMeta('admin_password','migration-fixture');
  vi.stubEnv('POKER_SSO_SECRET','local-fixture');
  const balance=vi.spyOn(settle,'getBalance').mockResolvedValue({balance:250});
  let app=await createApp(opts);
  const url=(path:string)=>'http://127.0.0.1:'+app.port+'/api/'+path;
  const post=(path:string,body:object)=>fetch(url(path),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    expect(store.getMeta('admin_password')).toBeNull();
    expect(store.getMeta('admin_password_hash')).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
    expect((await post('admin/login',{password:'migration-fixture'})).status).toBe(200);
    const ts=Math.floor(Date.now()/1000),uid='test_account';
    const sig=createHmac('sha256','local-fixture').update(uid+':'+ts+':0:').digest('hex').slice(0,32);
    const ticket={uid,ts,sig};
    const response=await post('sso',ticket);
    expect(response.status).toBe(200);
    const headers={Authorization:'Bearer '+(await response.json()).cardToken};
    await app.close();app=await createApp(opts);
    expect((await post('sso',ticket)).status).toBe(401);
    for(const path of ['lastresult','me/balance']){
      expect((await fetch(url(path))).status).toBe(401);
      expect((await fetch(url(path+'?uid=other'),{headers})).status).toBe(403);
      expect((await fetch(url(path),{headers})).status).toBe(200);
    }
    expect(balance).toHaveBeenLastCalledWith(uid);
  }finally{await app.close();store.close();balance.mockRestore();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true})}
});
