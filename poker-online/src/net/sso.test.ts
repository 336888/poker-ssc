import {afterEach,expect,it,vi} from 'vitest';
import {handleSsoUrl,ssoUid} from './sso';

afterEach(()=>vi.unstubAllGlobals());
function setup(reply:object,status:number){
  const values=new Map<string,string>();
  const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)};
  vi.stubGlobal('sessionStorage',storage);
  vi.stubGlobal('localStorage',storage);
  vi.stubGlobal('location',{search:'?game=pdk&sso=test.123.sig',pathname:'/poker/',hash:''});
  vi.stubGlobal('history',{replaceState:vi.fn()});
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(reply),{status})));
}
it('钱包不可用时保留重试入口并拒绝旧身份',async()=>{
  setup({error:'棋牌钱包暂不可用'},503);
  sessionStorage.setItem('poker.walletToken','stale');
  sessionStorage.setItem('poker.sso.uid','previous');
  await expect(handleSsoUrl('/api')).rejects.toThrow('钱包暂不可用');
  expect(ssoUid()).toBe('');
  expect(history.replaceState).not.toHaveBeenCalled();
});
it('必须收到当前账号的凭据，验证后移除链接中的签名',async()=>{
  setup({uid:'test',cardToken:'ticket'},200);
  expect(await handleSsoUrl('/api')).toBe('test');
  expect(history.replaceState).toHaveBeenCalledWith(null,'','/poker/?game=pdk');
});
