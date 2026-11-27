// 运行时配置：定时从主站拉取（机器人胜率、房间费），失败时用默认值
const MAIN = process.env.MAIN_API || 'http://127.0.0.1:8090';

export interface RtCfg {
  botRate: number;   // 机器人目标胜率 0.50~0.75
  fee: number;       // 中途退出房间费
  msgRate: number;   // 每秒最大消息数
  actMs: number;     // 最小操作间隔（毫秒）
  sameDev: number;   // 同机检测开关 1/0
  minBal: number;    // 准入最低余额
  names: string[];   // 假人名字池（跟随主系统）
}

let cfg: RtCfg = { botRate: 0.63, fee: 1, msgRate: 30, actMs: 250, sameDev: 1, minBal: 50, names: [] };
let started = false;

export function rtCfg(): RtCfg {
  return cfg;
}

export const botGames=['doudizhu','paodekuai','zjh','nn'] as const;
export type BotGame=typeof botGames[number];
export type BotTargets=Partial<Record<BotGame,number>>;
let targets:BotTargets={};
export function useTargets(next:BotTargets){targets={...next}}
export function gameRate(game:BotGame){return (targets[game]??(cfg.botRate*100))/100}

/** 目标胜率 → 困难策略占比。基线：normal 60%、hard 69% */
export function hardProb(game:BotGame): number {
  const t = Math.max(0.5, Math.min(0.75, gameRate(game)));
  const p = targets[game]===undefined ? (t-0.60)/0.09 : (t-0.50)/0.25;
  return Math.max(0, Math.min(1, p));
}

export async function startRtCfg(readBotNames: () => string[]) {
  if (started) return;
  started = true;
  const pull = async () => {
    try {
      const r = await fetch(MAIN + '/api/poker/config', { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      if (j && j.code === 0 && j.data) {
        console.log('拉取配置', JSON.stringify(j.data));
        cfg = {
          botRate: Number(j.data.botRate) || 0.63,
          fee: Number(j.data.fee) || 1,
          msgRate: Number(j.data.msgRate) || 30,
          actMs: Number(j.data.actMs) || 250,
          sameDev: j.data.sameDev === 0 ? 0 : 1,
          minBal: Number(j.data.minBal) || 50,
          names: cfg.names,
        };
      }
    } catch (e) {
      console.log('拉取配置失败', (e as Error).message);
    }
  };
  const pullNames = () => {
    try {
      const names = readBotNames();
      cfg = { ...cfg, names };
      console.log('主站机器人名字已同步', names.length);
    } catch (e) { console.log('名字池拉取失败', (e as Error).message); }
  };
  // 启动时先等名字池就绪（避免首批补位用旧名字）
  await Promise.all([pull(), pullNames()]);
  setInterval(pull, 60_000);
  setInterval(pullNames, 60_000);
}
