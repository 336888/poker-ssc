// 每局结算结果缓存：key = uid，value = { delta, balance, room, at }
export interface SettleResult {
  delta: number;
  balance: number | null;
  room: string;
  at: number;
}

const TTL = 10 * 60 * 1000;
const map = new Map<string, SettleResult>();

export function putResult(uid: string, r: SettleResult) {
  map.set(uid, r);
  // 顺手清理过期
  const now = Date.now();
  for (const [k, v] of map) if (now - v.at > TTL) map.delete(k);
}

export function clearResult(uid: string) {
  map.delete(uid);
}

export function getResult(uid: string): SettleResult | null {
  const r = map.get(uid);
  if (!r) return null;
  if (Date.now() - r.at > TTL) {
    map.delete(uid);
    return null;
  }
  return r;
}


// 连胜统计（持久化到 meta 表，重启不丢）
let _store: { getMeta(k: string): string | null; setMeta(k: string, v: string): void } | null = null;

export function bindStore(st: typeof _store) {
  _store = st;
}

type StreakMap = Record<string, { streak: number; at: number }>;

function loadStreaks(): StreakMap {
  if (!_store) return {};
  try { return JSON.parse(_store.getMeta('streaks') || '{}') as StreakMap; } catch { return {}; }
}

function saveStreaks(m: StreakMap) {
  if (!_store) return;
  try { _store.setMeta('streaks', JSON.stringify(m)); } catch { /* 忽略 */ }
}

const STREAK_TTL = 30 * 60 * 1000;

export function bumpStreak(uid: string, win: boolean): number {
  const m = loadStreaks();
  const now = Date.now();
  // 顺手清理过期
  for (const k of Object.keys(m)) if (now - m[k].at > STREAK_TTL) delete m[k];
  const cur = m[uid];
  const streak = win ? (cur?.streak ?? 0) + 1 : 0;
  m[uid] = { streak, at: now };
  saveStreaks(m);
  return streak;
}

export function getStreak(uid: string): number {
  const m = loadStreaks();
  const s = m[uid];
  if (!s) return 0;
  if (Date.now() - s.at > STREAK_TTL) return 0;
  return s.streak;
}
