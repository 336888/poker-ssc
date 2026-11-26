import { useEffect, useState } from 'react';
import { lobbyApi } from '../net/api';
import { profileStore } from '../net/storage';
import { handleSsoUrl } from '../net/sso';
import { useRoom } from '../store/RoomContext';

export function Home() {
  const { createRoom, link, notify } = useRoom();
  const gameParam = new URLSearchParams(location.search).get('game') ?? '';
  const initialGame =
    gameParam === 'doudizhu' || gameParam === 'ddz' ? 'doudizhu'
    : gameParam === 'pdk' || gameParam === 'paodekuai' ? 'paodekuai'
    : '';
  if (initialGame) sessionStorage.setItem('poker.lockedMode', initialGame);
  const gameName = initialGame === 'doudizhu' ? '斗地主' : initialGame === 'paodekuai' ? '跑得快' : '';

  const [name, setName] = useState(() => profileStore.getName());
  const [busy, setBusy] = useState(false);

  const [checking,setChecking]=useState(new URLSearchParams(location.search).has('sso'));
  const [loginError,setLoginError]=useState('');
  useEffect(() => {
    document.title = (gameName || '在线牌局') + ' · 飞龙娱乐';
    const apiBase = (import.meta.env.VITE_API_URL as string) || '/api';
    void handleSsoUrl(apiBase).then((uid) => {
      if (uid) {
        setName(uid);
        profileStore.setName(uid);
      }
    }).catch(e=>setLoginError(e instanceof Error?e.message:'登录验证失败'))
      .finally(()=>setChecking(false));
  }, []);

  const onStart = async () => {
    if(busy||checking)return;
    setBusy(true);
    try {
      const uid=await handleSsoUrl((import.meta.env.VITE_API_URL as string)||'/api');
      setLoginError('');
      const n=(uid||name).trim() || '玩家'+Math.floor(Math.random()*9000+1000);
      profileStore.setName(n);
      await createRoom(n, initialGame ? { mode: initialGame as 'doudizhu' | 'paodekuai' } : undefined);
      history.replaceState(null, '', location.pathname + location.hash);
    } catch (e) {
      if(new URLSearchParams(location.search).has('sso'))setLoginError((e as Error).message);
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (link === 'connecting') {
    return (
      <div className="mini">
        <div className="mini-loading">
          <div className="mini-spin" />
          <p>正在进入牌局…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mini">
      {/* 品牌 */}
      <div className="mini-brand">
        <div className="mini-mark">FL</div>
        <div className="mini-name">飞龙娱乐</div>
        <div className="mini-sub">
          {gameName ? gameName + ' · 3 人成局' : '跑得快 · 斗地主'}
        </div>
      </div>

      {/* 唯一按钮 */}
      <button className="mini-start" disabled={busy||checking} onClick={onStart}>
        {checking?'验证登录中…':busy?'进入中…':loginError?'重试登录并进入':'开始游戏'}
      </button>

      {!initialGame && (
        <nav aria-label="五人棋牌" style={{display:'flex', gap:'1.5rem', marginTop:'1rem'}}>
          <a href="/#play-zjh">炸金花 · 五人桌</a>
          <a href="/#play-nn">牛牛 · 五人桌</a>
        </nav>
      )}

      {loginError && <p role="alert" className="mini-tip">{loginError} · <a href="/">返回主站</a></p>}
      {lobbyApi.mode === 'mock' && (
        <p className="mini-tip">本地演示模式</p>
      )}
    </div>
  );
}
