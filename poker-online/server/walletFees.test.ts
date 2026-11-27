import { expect, it } from 'vitest';
import { leaveAmount, leaveMultiplier } from '../src/game/walletFees';
import { calcDeltas } from './settle';

it('跑得快退桌与结算使用相同的炸弹倍数，斗地主保留角色倍数', () => {
  for (const bombs of [0, 1, 3, 7]) {
    const quote = leaveMultiplier('paodekuai', bombs, [16, 12, 3]);
    expect(quote).toBe(calcDeltas([], 1, 0, 'paodekuai', bombs).mult);
    expect(leaveAmount(quote)).toBe(2 ** Math.min(6, bombs));
  }
  expect(leaveAmount(leaveMultiplier('doudizhu', 0, [16, 12, 3]), 'landlord')).toBe(8);
});
