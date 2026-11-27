import type { ReactNode } from 'react';
import './game-entry.css';

export function HallReturn({ onReturn, disabled }: {onReturn?: () => void; disabled?: boolean}) {
  const label = <><span aria-hidden="true">‹</span> 返回大厅</>;
  return onReturn || disabled
    ? <button type="button" className="hall-return" disabled={disabled} onClick={onReturn}>{label}</button>
    : <a className="hall-return" href="/">{label}</a>;
}

export function GameEntry({title, detail, onReturn, children}: {
  title: string; detail: string; onReturn?: () => void; children: ReactNode;
}) {
  return <main className="entry-screen">
    <header className="entry-nav"><HallReturn onReturn={onReturn}/></header>
    <section className="entry-panel">
      <div className="entry-cover"><div className="entry-fan" aria-hidden="true">
        <i>♣</i><i>♥</i><i>♠</i></div><h1>{title}</h1><p>{detail}</p></div>
      <div className="entry-controls">{children}</div>
    </section>
  </main>;
}
