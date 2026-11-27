// 主站单点登录：从 URL 读取 sso 参数，向后端验证后保存 uid

const KEY = 'poker.sso.uid';

export function ssoUid(): string {
  return sessionStorage.getItem('poker.walletToken') && sessionStorage.getItem(KEY) || '';
}

export function clearSso(): void {
  sessionStorage.removeItem('poker.walletToken');sessionStorage.removeItem(KEY);localStorage.removeItem(KEY);
}

/** 处理 URL 上的 ?sso=uid.ts.sig，验证成功后返回 uid */
export async function handleSsoUrl(apiBase: string): Promise<string> {
  const q = new URLSearchParams(location.search);
  const raw = q.get('sso');
  if (raw === null) return ssoUid();
  clearSso();
  const parts = raw.split('.');
  if (parts.length !== 3) throw new Error('登录凭据无效，请从主站重新进入');
  const [uid, ts, sig] = parts;
  const res = await fetch(apiBase + '/sso', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, ts: Number(ts), sig }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.uid !== uid || !data.cardToken)
    throw new Error(data.error || '钱包身份未确认，请从主站重新进入');
  sessionStorage.setItem(KEY, uid);
  sessionStorage.setItem('poker.walletToken', data.cardToken);
  q.delete('sso');
  const qs = q.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  return uid;
}


/** 浏览器指纹（同机识别用，不含隐私信息） */
export function fingerprint(): string {
  const KEY = 'poker.fp';
  const cached = localStorage.getItem(KEY);
  if (cached) return cached;
  const raw = [
    navigator.userAgent,
    screen.width + 'x' + screen.height,
    screen.colorDepth,
    navigator.language,
    new Date().getTimezoneOffset(),
    navigator.hardwareConcurrency || 0,
    (navigator as any).deviceMemory || 0,
  ].join('|');
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0;
  const fp = (h >>> 0).toString(36) + Math.abs(h % 997).toString(36);
  localStorage.setItem(KEY, fp);
  return fp;
}

export function walletRead(path:'/me/balance'|'/lastresult', roundId?:string) {
  const token=sessionStorage.getItem('poker.walletToken');
  if(!token)return Promise.resolve(null);
  const base=(import.meta.env.VITE_API_URL as string)||'/api';
  return fetch(base+path+(roundId ? '?roundId='+encodeURIComponent(roundId) : ''),{signal:AbortSignal.timeout(8000),headers:{Authorization:'Bearer '+token},cache:'no-store'})
    .then(r=>r.ok?r.json():null);
}
