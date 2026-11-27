import type { GameMode } from './rules';

export function runningMultiplier(bombs: number) {
  return 2 ** Math.max(0, Math.min(6, bombs || 0));
}

export function leaveMultiplier(mode: GameMode, bombs: number, handCounts: number[]) {
  if (mode === 'paodekuai') return runningMultiplier(bombs);
  const max = Math.max(0, ...handCounts);
  return max >= 15 ? 4 : max >= 10 ? 2 : 1;
}

export function leaveAmount(multiplier: number, role?: string) {
  return multiplier * (role === 'landlord' ? 2 : 1);
}
