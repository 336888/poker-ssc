import { lazy, Suspense, useEffect, useState } from 'react';
import { LinkBanner, Toasts } from './components/common';
import { Home } from './pages/Home';

import { RoomProvider, useRoom } from './store/RoomContext';

const Admin = lazy(() => import('./pages/Admin').then(module => ({ default: module.Admin })));

const GameTable = lazy(() => import('./pages/GameTable').then(module => ({ default: module.GameTable })));

const Lobby = lazy(() => import('./pages/Lobby').then(module => ({ default: module.Lobby })));

function useHashRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const fn = () => setHash(location.hash);
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  return hash.replace(/^#\/?/, '');
}

function Screen() {
  const { view } = useRoom();
  const route = useHashRoute();
  // 后台入口：/admin 或 #/admin，前台页面不提供任何链接
  if (route === 'admin' || /\/admin\/?$/.test(location.pathname)) return <Admin />;
  if (!view) return <Home />;
  if (view.room.status === 'waiting' || !view.game) return <Lobby view={view} />;
  return <GameTable view={view} />;
}

export function App() {
  return (
    <RoomProvider>
      <Suspense fallback={<p role="status">页面加载中…</p>}>
        <Screen />
      </Suspense>
      <LinkBanner />
      <Toasts />
    </RoomProvider>
  );
}
