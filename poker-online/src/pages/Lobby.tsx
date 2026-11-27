import { useWalletBalance } from '../net/useWalletBalance';

import { GameEntry } from '../components/GameEntry';
import { ChatBubble, ChatButton, useChatBubbles, useChatSound } from '../components/Chat';
import { Avatar } from '../components/common';
import { ServerView } from '../net/protocol';
import { useRoom } from '../store/RoomContext';
import { useNow } from './GameTable';

export function Lobby({ view }: { view: ServerView }) {
  const walletBalance = useWalletBalance(view.you);
  const { send, leaveRoom } = useRoom();
  const { room, you } = view;
  const now = useNow(500);
  const cfg = room.config;
  const me = room.players.find((p) => p.id === you);
  const ddz = cfg.mode === 'doudizhu';
  const humans = room.players.filter((p) => p.kind !== 'ai');
  const aiNeeded = Math.max(0, cfg.seatCount - humans.length);
  const notReady = humans.filter((p) => !p.ready && !p.isHost);
  const bubbles = useChatBubbles(room.chat, now);
  useChatSound(room.chat, you);

  if (typeof document !== 'undefined') {
    document.title = (ddz ? '斗地主' : '跑得快') + ' · 飞龙娱乐';
  }

  const doLeave = async () => {
    try {
      await fetch('/api/wallet/leave', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + (localStorage.getItem('token') || ''),
        },
        body: '{}',
      });
    } catch { /* ignore */ }
    leaveRoom();
    window.location.assign('/');
  };

  const canStart = humans.length >= cfg.seatCount && notReady.length === 0;
  const startLabel =
    aiNeeded > 0 ? '匹配中 ' + humans.length + '/' + cfg.seatCount
    : notReady.length ? '等待玩家准备'
    : '开始游戏';

  return (
    <GameEntry title={ddz ? '斗地主' : '跑得快'} detail={cfg.seatCount+' 人成局'} onReturn={doLeave}>
      <div className="mini-seats">
        {room.players.map((p, i) => (
          <div key={p.id} className={'mini-seat' + (p.id === you ? ' is-me' : '')}>
            <div className="mini-seat__no">{i + 1}</div>
            <Avatar name={p.name} kind={p.kind} size={34} />
            <div className="mini-seat__name">
              <span className="mini-name-txt">
                {p.name}
                {p.id === you && <span className="mini-me">你</span>}
                {p.isHost && <span className="mini-host">房主</span>}
              </span>
              {(() => {
                if (p.id === you && walletBalance !== null) return <span className="mini-bal">{walletBalance}</span>;
                const v = (typeof (p as any).balance === 'number' ? (p as any).balance : null);
                return v !== null ? <span className="mini-bal">￥{v.toFixed(2)}</span> : null;
              })()}
            </div>
            <ChatBubble message={bubbles[p.id]} className="mini-bubble" />
            <div className={'mini-dot' + (p.online ? ' on' : '')} />
          </div>
        ))}
        {Array.from({ length: aiNeeded }, (_, i) => (
          <div key={'e' + i} className="mini-seat mini-seat--empty">
            <div className="mini-seat__no">{humans.length + i + 1}</div>
            <div className="mini-ava-empty">+</div>
            <div className="mini-seat__name muted">匹配中…</div>
          </div>
        ))}
      </div>

      <button className="mini-start" disabled={!canStart} onClick={() => send(me?.isHost ? { type: 'start' } : { type: 'ready', ready: true })}>
        {startLabel}
      </button>

      <div className="mini-foot">
        <ChatButton policy={cfg.chat} chat={room.chat} you={you} compact />
      </div>
    </GameEntry>
  );
}
