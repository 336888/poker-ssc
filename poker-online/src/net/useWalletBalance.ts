import { useEffect, useState } from 'react';
import { ssoUid, walletRead } from './sso';

export function useWalletBalance(player: string) {
  const uid = ssoUid();
  const [result, setResult] = useState<{uid: string; text: string} | null>(null);
  useEffect(() => {
    if (!uid || uid !== player) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      let text = '余额刷新失败';
      try {
        const data = await walletRead('/me/balance');
        if (Number.isFinite(data?.balance)) text = '￥' + data.balance.toFixed(2);
      } catch { /* 下次轮询重试 */ }
      if (active) {
        setResult({uid, text});
        timer = setTimeout(refresh, 5000);
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [player, uid]);
  if (!uid || uid !== player) return null;
  return result?.uid === uid ? result.text : '余额更新中';
}
