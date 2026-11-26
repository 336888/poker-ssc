var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// server/rtcfg.ts
var rtcfg_exports = {};
__export(rtcfg_exports, {
  botGames: () => botGames,
  gameRate: () => gameRate,
  hardProb: () => hardProb,
  rtCfg: () => rtCfg,
  startRtCfg: () => startRtCfg,
  useTargets: () => useTargets
});
function rtCfg() {
  return cfg;
}
function useTargets(next) {
  targets = { ...next };
}
function gameRate(game) {
  return (targets[game] ?? cfg.botRate * 100) / 100;
}
function hardProb(game) {
  const t = Math.max(0.5, Math.min(0.75, gameRate(game)));
  const p = targets[game] === void 0 ? (t - 0.6) / 0.09 : (t - 0.5) / 0.25;
  return Math.max(0, Math.min(1, p));
}
async function startRtCfg() {
  if (started) return;
  started = true;
  const pull = async () => {
    try {
      const r = await fetch(MAIN + "/api/poker/config", { signal: AbortSignal.timeout(5e3) });
      const j = await r.json();
      if (j && j.code === 0 && j.data) {
        console.log("\u62C9\u53D6\u914D\u7F6E", JSON.stringify(j.data));
        cfg = {
          botRate: Number(j.data.botRate) || 0.63,
          fee: Number(j.data.fee) || 1,
          msgRate: Number(j.data.msgRate) || 30,
          actMs: Number(j.data.actMs) || 250,
          sameDev: j.data.sameDev === 0 ? 0 : 1,
          minBal: Number(j.data.minBal) || 50,
          names: Array.isArray(j.data.names) ? j.data.names : []
        };
      }
    } catch (e) {
      console.log("\u62C9\u53D6\u914D\u7F6E\u5931\u8D25", e.message);
    }
  };
  const pullNames = async () => {
    try {
      const r = await fetch(MAIN + "/api/bot/names?n=200", { signal: AbortSignal.timeout(5e3) });
      const j = await r.json();
      if (j && j.code === 0 && Array.isArray(j.data) && j.data.length) {
        cfg = { ...cfg, names: j.data };
        console.log("\u540D\u5B57\u6C60\u5DF2\u52A0\u8F7D", j.data.length, "\u4E2A\uFF0C\u4F8B\u5982", j.data.slice(0, 3).join(","));
      } else {
        console.log("\u540D\u5B57\u6C60\u5F02\u5E38", JSON.stringify(j).slice(0, 80));
      }
    } catch (e) {
      console.log("\u540D\u5B57\u6C60\u62C9\u53D6\u5931\u8D25", e.message);
    }
  };
  await Promise.all([pull(), pullNames()]);
  setInterval(pull, 6e4);
  setInterval(pullNames, 3e5);
}
var MAIN, cfg, started, botGames, targets;
var init_rtcfg = __esm({
  "server/rtcfg.ts"() {
    "use strict";
    MAIN = process.env.MAIN_API || "http://127.0.0.1:8090";
    cfg = { botRate: 0.63, fee: 1, msgRate: 30, actMs: 250, sameDev: 1, minBal: 50, names: [] };
    started = false;
    botGames = ["doudizhu", "paodekuai", "zjh", "nn"];
    targets = {};
  }
});

// server/settle.ts
var settle_exports = {};
__export(settle_exports, {
  bookRound: () => bookRound,
  calcDeltas: () => calcDeltas,
  chargeFee: () => chargeFee,
  getBalance: () => getBalance
});
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";
import { existsSync } from "node:fs";
import { createHmac as createHmac2 } from "node:crypto";
function sig(uid, ts, amount, action) {
  return createHmac2("sha256", SECRET).update(`${uid}:${ts}:${amount}:${action}`).digest("hex").slice(0, 32);
}
async function bridge(uid, action, amount = 0, detail) {
  if (!SECRET) throw new Error("\u672A\u914D\u7F6E POKER_SSO_SECRET");
  const ts = Math.floor(Date.now() / 1e3);
  const body = { uid, ts, sig: sig(uid, ts, amount, action), action, amount };
  if (detail) body.detail = detail;
  const r = await fetch(`${MAIN2}/api/poker/bridge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) throw new Error(j.msg || `bridge ${action} \u5931\u8D25`);
  return j.data;
}
function multiplier(rows) {
  const last = rows.find((r) => r.rank === 3);
  if (!last) return 1;
  if (last.remaining >= 15) return 4;
  if (last.remaining >= 10) return 2;
  return 1;
}
function calcDeltas(rows, base = 1, rake = 0.05, mode = "paodekuai", bombs = 0) {
  const mult = mode === "paodekuai" ? Math.pow(2, Math.max(0, Math.min(6, Number(bombs) || 0))) : multiplier(rows);
  const pot = base * mult;
  const deltas = [];
  if (mode === "doudizhu") {
    const lord = rows.find((r) => r.role === "landlord");
    const farmers = rows.filter((r) => r.role === "farmer");
    const lordWon = lord && farmers.length ? farmers.every((f) => f.rank >= 2) : false;
    if (lord) {
      if (lordWon) {
        deltas.push({ uid: lord.uid, delta: Math.round(pot * farmers.length * (1 - rake) * 100) / 100 });
        for (const f of farmers) deltas.push({ uid: f.uid, delta: -pot });
      } else {
        deltas.push({ uid: lord.uid, delta: -pot * farmers.length });
        for (const f of farmers) deltas.push({ uid: f.uid, delta: Math.round(pot * (1 - rake) * 100) / 100 });
      }
    }
  } else {
    const winner = rows.find((r) => r.rank === 1);
    const others = rows.filter((r) => r.rank !== 1);
    if (winner && others.length) {
      let totalLose = 0;
      for (const r of others) {
        const cards = Number(r.remaining) || 0;
        if (cards <= 1) {
          deltas.push({ uid: r.uid, delta: 0 });
          continue;
        }
        const lose = Math.round(cards * pot * 100) / 100;
        totalLose += lose;
        deltas.push({ uid: r.uid, delta: -lose });
      }
      const win = Math.round(totalLose * (1 - rake) * 100) / 100;
      deltas.push({ uid: winner.uid, delta: win });
    }
  }
  return { mult, pot, deltas };
}
function bookRound(id, deltas) {
  const path = process.env.CARD_WALLET_DB || "/opt/ssc-ops/ssc_ops.db";
  if (!existsSync(path)) throw new Error("\u68CB\u724C\u94B1\u5305\u6570\u636E\u5E93\u672A\u63A5\u5165");
  const db = new DatabaseSync3(path);
  try {
    db.exec("PRAGMA busy_timeout=3000; BEGIN IMMEDIATE");
    db.exec("CREATE TABLE IF NOT EXISTS poker_round_receipts(id TEXT PRIMARY KEY, receipt TEXT NOT NULL)");
    const prior = db.prepare("SELECT receipt FROM poker_round_receipts WHERE id=?").get(id);
    if (prior) {
      db.exec("COMMIT");
      return { fresh: false, moves: JSON.parse(String(prior.receipt)) };
    }
    const moves = deltas.map(({ uid, delta }) => {
      const row = db.prepare("UPDATE users SET poker_balance=round(poker_balance+?,2) WHERE uid=? AND poker_balance+?>=0 RETURNING poker_balance").get(delta, uid, delta);
      if (!row) throw new Error("\u94B1\u5305\u4E0D\u5B58\u5728\u6216\u4F59\u989D\u4E0D\u8DB3");
      const balance = Number(row.poker_balance);
      if (delta) db.prepare("INSERT INTO flows(uid,kind,amount,balance,ref,memo,ctime) VALUES(?,?,?,?,?,?,?)").run(uid, delta > 0 ? "poker_win" : "poker_lose", delta, balance, id, "\u724C\u5C40\u7ED3\u7B97", Math.floor(Date.now() / 1e3));
      return { uid, delta, balance };
    });
    db.prepare("INSERT INTO poker_round_receipts VALUES(?,?)").run(id, JSON.stringify(moves));
    db.exec("COMMIT");
    return { fresh: true, moves };
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  } finally {
    db.close();
  }
}
async function getBalance(uid) {
  return bridge(uid, "balance", 0);
}
async function chargeFee(uid, amount = 1) {
  const r = await bridge(uid, "lose", amount);
  return { uid, amount, balance: r?.balance };
}
var MAIN2, SECRET;
var init_settle = __esm({
  "server/settle.ts"() {
    "use strict";
    MAIN2 = process.env.MAIN_API || "http://127.0.0.1:8090";
    SECRET = process.env.POKER_SSO_SECRET || "";
  }
});

// server/results.ts
var results_exports = {};
__export(results_exports, {
  bindStore: () => bindStore,
  bumpStreak: () => bumpStreak,
  getResult: () => getResult,
  getStreak: () => getStreak,
  putResult: () => putResult
});
function putResult(uid, r) {
  map.set(uid, r);
  const now = Date.now();
  for (const [k, v] of map) if (now - v.at > TTL) map.delete(k);
}
function getResult(uid) {
  const r = map.get(uid);
  if (!r) return null;
  if (Date.now() - r.at > TTL) {
    map.delete(uid);
    return null;
  }
  return r;
}
function bindStore(st) {
  _store = st;
}
function loadStreaks() {
  if (!_store) return {};
  try {
    return JSON.parse(_store.getMeta("streaks") || "{}");
  } catch {
    return {};
  }
}
function saveStreaks(m) {
  if (!_store) return;
  try {
    _store.setMeta("streaks", JSON.stringify(m));
  } catch {
  }
}
function bumpStreak(uid, win) {
  const m = loadStreaks();
  const now = Date.now();
  for (const k of Object.keys(m)) if (now - m[k].at > STREAK_TTL) delete m[k];
  const cur = m[uid];
  const streak = win ? (cur?.streak ?? 0) + 1 : 0;
  m[uid] = { streak, at: now };
  saveStreaks(m);
  return streak;
}
function getStreak(uid) {
  const m = loadStreaks();
  const s = m[uid];
  if (!s) return 0;
  if (Date.now() - s.at > STREAK_TTL) return 0;
  return s.streak;
}
var TTL, map, _store, STREAK_TTL;
var init_results = __esm({
  "server/results.ts"() {
    "use strict";
    TTL = 10 * 60 * 1e3;
    map = /* @__PURE__ */ new Map();
    _store = null;
    STREAK_TTL = 30 * 60 * 1e3;
  }
});

// server/index.ts
import { join as join2 } from "node:path";

// server/app.ts
import { createHmac as createHmac3, randomBytes as randomBytes2 } from "node:crypto";
import { existsSync as existsSync2, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize as normalize2, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

// src/net/moderation.ts
var QUICK_PHRASES = ["\u5FEB\u70B9", "\u597D\u724C", "\u5389\u5BB3", "\u8C22\u8C22", "\u7A0D\u7B49", "\u52A0\u6CB9", "\u5931\u8BEF", "\u518D\u6765", "\u54C8\u54C8", "\u627F\u8BA9", "666", "\u62B1\u6B49"];
var EMOJIS = ["\u{1F600}", "\u{1F602}", "\u{1F60E}", "\u{1F914}", "\u{1F605}", "\u{1F62D}", "\u{1F631}", "\u{1F624}", "\u{1F44D}", "\u{1F44F}", "\u{1F64F}", "\u{1F4AA}", "\u{1F389}", "\u{1F525}", "\u2764\uFE0F", "\u{1F339}"];
var MAX_TEXT_LENGTH = 6;
var BLOCKED_WORDS = [
  // 辱骂
  "\u50BB\u903C",
  "\u50BBb",
  "\u50BB\u6BD4",
  "\u715E\u7B14",
  "\u6C99\u6BD4",
  "\u50BB\u53C9",
  "\u4E8C\u903C",
  "\u9017\u6BD4",
  "\u8111\u6B8B",
  "\u667A\u969C",
  "\u5F31\u667A",
  "\u767D\u75F4",
  "\u8822\u8D27",
  "\u8822\u732A",
  "\u5E9F\u7269",
  "\u5783\u573E",
  "\u72D7\u4E1C\u897F",
  "\u8D31\u4EBA",
  "\u8D31\u8D27",
  "\u6742\u79CD",
  "\u755C\u751F",
  "\u4EBA\u6E23",
  "\u8D25\u7C7B",
  "\u6EDA\u86CB",
  "\u6EDA\u7C97",
  "\u53BB\u6B7B",
  "\u6B7B\u5168\u5BB6",
  "\u5168\u5BB6\u6B7B",
  "\u72D7\u65E5",
  "\u65E5\u4F60",
  "\u5C3C\u739B",
  "\u4F60\u5988",
  "\u4F60\u5988\u7684",
  "\u5988\u7684",
  "\u4ED6\u5988",
  "\u5979\u5988",
  "\u7279\u4E48",
  "\u6CE5\u9A6C",
  "\u8349\u6CE5\u9A6C",
  "\u64CD\u4F60",
  "\u808F",
  "\u8279",
  "\u5367\u69FD",
  "\u6211\u8349",
  "\u6211\u64CD",
  "\u63E1\u8349",
  "\u5C4C",
  "\u5C4C\u4E1D",
  "\u5A4A",
  "\u9E21\u5DF4",
  "\u738B\u516B\u86CB",
  "\u9F9F\u5B59",
  "\u5B59\u5B50",
  "\u72D7\u5C4E",
  "\u5403\u5C4E",
  "\u5988\u903C",
  "\u9A9A\u8D27",
  "\u8D31",
  "\u83DC\u72D7",
  "\u83DC\u9E21",
  "\u8FA3\u9E21",
  "\u62C9\u573E",
  "\u53BB\u4F60\u7684",
  // 拼音缩写 / 英文
  "sb",
  "nmsl",
  "cnm",
  "nmb",
  "tmd",
  "mlgb",
  "wcnm",
  "nnd",
  "rnm",
  "qnmd",
  "nima",
  "caonima",
  "shabi",
  "fuck",
  "fck",
  "fuk",
  "shit",
  "bitch",
  "dick",
  "cunt",
  "asshole",
  "bastard",
  "damn",
  "stfu",
  "wtf",
  "idiot",
  "stupid",
  "loser",
  // 色情
  "\u8272\u60C5",
  "\u7EA6\u70AE",
  "\u88F8\u804A",
  "\u5AD6",
  "\u5993",
  "\u505A\u7231",
  "\u6027\u4EA4",
  "\u9EC4\u7247",
  "\u63F4\u4EA4",
  // 暴力 / 威胁
  "\u6740\u4E86\u4F60",
  "\u780D\u6B7B",
  "\u5F04\u6B7B",
  "\u6253\u6B7B\u4F60",
  "\u6740\u4F60",
  "\u70B8\u6B7B",
  // 歧视
  "\u9ED1\u9B3C",
  "\u652F\u90A3",
  "\u6B8B\u5E9F",
  "\u5A18\u70AE",
  "\u6B7B\u80D6\u5B50",
  // 赌博 / 广告 / 引流
  "\u52A0\u5FAE\u4FE1",
  "\u52A0\u6211",
  "\u5FAE\u4FE1",
  "\u5A01\u4FE1",
  "vx",
  "wx",
  "qq",
  "\u6263\u6263",
  "\u4F01\u9E45",
  "\u4EE3\u7EC3",
  "\u4EE3\u6253",
  "\u5145\u503C",
  "\u8FD4\u5229",
  "\u8D4C\u535A",
  "\u8D4C\u94B1",
  "\u4E0B\u6CE8",
  "\u5F69\u7968",
  "\u535A\u5F69",
  "\u5237\u5355",
  "\u517C\u804C",
  "\u52A0\u7FA4",
  "\u79C1\u804A",
  "http",
  "www"
];
var ALLOWED_WORDS = ["\u64CD\u4F5C", "\u4F53\u64CD", "\u8282\u64CD", "\u8D31\u5356", "\u5B59\u5B50\u5175\u6CD5", "\u5783\u573E\u724C"];
var ALLOWED_CHARS = /^[一-龥a-zA-Z0-9，。！？、~～!?,. ]+$/;
function normalize(text) {
  return text.normalize("NFKC").toLowerCase().replace(/[​-‏⁠﻿\s]/g, "").replace(/[`~!@#$%^&*()\-_=+[\]{}\\|;:'".,<>/?，。！？、；：“”‘’（）【】《》·…—～]/g, "").replace(/[0]/g, "o");
}
function containsBlocked(text) {
  let s = normalize(text);
  for (const w of ALLOWED_WORDS) s = s.split(w).join("");
  if (BLOCKED_WORDS.some((w) => s.includes(normalize(w)))) return true;
  if (/\d{5,}/.test(text.normalize("NFKC").replace(/\s/g, ""))) return true;
  return false;
}
function checkText(raw) {
  const text = raw.normalize("NFKC").trim();
  if (!text) return { ok: false, reason: "\u6D88\u606F\u4E0D\u80FD\u4E3A\u7A7A" };
  if ([...text].length > MAX_TEXT_LENGTH) return { ok: false, reason: `\u6700\u591A ${MAX_TEXT_LENGTH} \u4E2A\u5B57` };
  if (!ALLOWED_CHARS.test(text)) return { ok: false, reason: "\u53EA\u80FD\u53D1\u9001\u6587\u5B57\uFF0C\u8868\u60C5\u8BF7\u4ECE\u8868\u60C5\u9762\u677F\u9009\u62E9" };
  if (containsBlocked(text)) return { ok: false, reason: "\u6D88\u606F\u5305\u542B\u4E0D\u6587\u660E\u5185\u5BB9\uFF0C\u5DF2\u88AB\u62E6\u622A" };
  return { ok: true, text };
}

// src/net/inviteCode.ts
var CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateInviteCode(exists, length = 6) {
  for (; ; ) {
    let code = "";
    for (let i = 0; i < length; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!exists(code)) return code;
  }
}
function normalizeCode(input) {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// src/game/cards.ts
var RANK_TWO = 15;
var RANK_SMALL_JOKER = 16;
var RANK_BIG_JOKER = 17;
var SUIT_ORDER = { D: 0, C: 1, H: 2, S: 3, J: 4 };
function createDecks(deckCount, withJokers) {
  const cards = [];
  for (let d = 0; d < deckCount; d++) {
    for (const suit2 of ["S", "H", "C", "D"]) {
      for (let rank2 = 3; rank2 <= 15; rank2++) {
        cards.push({ id: `d${d}-${suit2}-${rank2}`, suit: suit2, rank: rank2, deck: d });
      }
    }
    if (withJokers) {
      cards.push({ id: `d${d}-J-16`, suit: "J", rank: RANK_SMALL_JOKER, deck: d });
      cards.push({ id: `d${d}-J-17`, suit: "J", rank: RANK_BIG_JOKER, deck: d });
    }
  }
  return cards;
}
function randomInt(max) {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % max;
  }
  return Math.floor(Math.random() * max);
}
function shuffle(items) {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function compareCards(a, b) {
  return a.rank - b.rank || SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit] || a.deck - b.deck;
}
function sortByRank(cards) {
  return cards.slice().sort(compareCards);
}
function recommendedDecks(players) {
  if (players <= 3) return 1;
  if (players <= 5) return 2;
  return 3;
}

// src/game/rules.ts
var MAX_SEQ_RANK = 14;
function isBombLike(p) {
  return p.type === "bomb" || p.type === "rocket";
}
function countRanks(cards) {
  const m = /* @__PURE__ */ new Map();
  for (const c of cards) m.set(c.rank, (m.get(c.rank) ?? 0) + 1);
  return m;
}
function isConsecutive(ranks) {
  for (let i = 1; i < ranks.length; i++) if (ranks[i] !== ranks[i - 1] + 1) return false;
  return true;
}
function make(type, mainRank, length, cardCount, power = 0) {
  return { type, mainRank, length, cardCount, power };
}
function bombPower(count, rank2) {
  return count * 100 + rank2;
}
function rocketPower(jokers) {
  return (jokers * 2 + 1) * 100;
}
function analyze(cards, mode = "paodekuai") {
  const n = cards.length;
  if (n === 0) return [];
  const counts = countRanks(cards);
  const ranks = [...counts.keys()].sort((a, b) => a - b);
  const result = [];
  if (n >= 2 && ranks.every((r) => r >= RANK_SMALL_JOKER) && counts.has(RANK_SMALL_JOKER) && counts.has(RANK_BIG_JOKER)) {
    return [make("rocket", RANK_BIG_JOKER, 1, n, rocketPower(n))];
  }
  if (ranks.length === 1) {
    const r = ranks[0];
    if (n === 1) result.push(make("single", r, 1, 1));
    else if (n === 2) result.push(make("pair", r, 1, 2));
    else if (n === 3) result.push(make("triple", r, 1, 3));
    else result.push(make("bomb", r, 1, n, bombPower(n, r)));
    return result;
  }
  const values = ranks.map((r) => counts.get(r));
  if (n === 4 && ranks.length === 2) {
    const t = ranks.find((r) => counts.get(r) === 3);
    if (t !== void 0) result.push(make("triple_one", t, 1, 4));
  }
  if (n === 5 && ranks.length === 2) {
    const t = ranks.find((r) => counts.get(r) === 3);
    const p = ranks.find((r) => counts.get(r) === 2);
    if (t !== void 0 && p !== void 0) result.push(make("triple_two", t, 1, 5));
  }
  if (n >= 5 && values.every((v) => v === 1) && ranks[ranks.length - 1] <= MAX_SEQ_RANK && isConsecutive(ranks)) {
    result.push(make("straight", ranks[ranks.length - 1], n, n));
  }
  if (n >= 6 && values.every((v) => v === 2) && ranks[ranks.length - 1] <= MAX_SEQ_RANK && isConsecutive(ranks)) {
    result.push(make("pair_seq", ranks[ranks.length - 1], n / 2, n));
  }
  if (mode === "doudizhu") {
    const quads = ranks.filter((r) => counts.get(r) === 4).sort((a, b) => b - a);
    for (const q of quads) {
      const rest = ranks.filter((r) => r !== q).map((r) => counts.get(r));
      if (n === 6) {
        result.push(make("four_two_single", q, 1, 6));
        break;
      }
      if (n === 8 && (rest.every((v) => v === 2) || rest.length === 1 && rest[0] === 4)) {
        result.push(make("four_two_pair", q, 1, 8));
        break;
      }
    }
  }
  const tripleCandidates = ranks.filter((r) => counts.get(r) >= 3 && r <= MAX_SEQ_RANK);
  for (let k = Math.floor(n / 3); k >= 2; k--) {
    const wings = n - 3 * k;
    let wingType = null;
    if (wings === 0) wingType = "plane";
    else if (wings === k) wingType = "plane_single";
    else if (wings === 2 * k) wingType = "plane_pair";
    if (!wingType) continue;
    for (let i = tripleCandidates.length - k; i >= 0; i--) {
      const seq = tripleCandidates.slice(i, i + k);
      if (!isConsecutive(seq)) continue;
      const rest = new Map(counts);
      for (const r of seq) rest.set(r, rest.get(r) - 3);
      if (wingType === "plane" && [...rest.values()].some((v) => v > 0)) continue;
      if (wingType === "plane_pair" && [...rest.values()].some((v) => v % 2 !== 0)) continue;
      result.push(make(wingType, seq[seq.length - 1], k, n));
      break;
    }
  }
  return result;
}
function primaryPattern(cards, mode = "paodekuai") {
  return analyze(cards, mode)[0] ?? null;
}
function beats(p, target) {
  if (isBombLike(p)) {
    if (!isBombLike(target)) return true;
    return p.power > target.power;
  }
  if (isBombLike(target)) return false;
  return p.type === target.type && p.length === target.length && p.cardCount === target.cardCount && p.mainRank > target.mainRank;
}
function resolvePlay(cards, target, mode = "paodekuai") {
  const options = analyze(cards, mode);
  if (!target) return options[0] ?? null;
  return options.find((p) => beats(p, target)) ?? null;
}

// src/game/ai.ts
function groupByRank(hand) {
  const m = /* @__PURE__ */ new Map();
  for (const c of sortByRank(hand)) {
    if (!m.has(c.rank)) m.set(c.rank, []);
    m.get(c.rank).push(c);
  }
  return m;
}
function generateMoves(hand, mode = "paodekuai") {
  const groups = groupByRank(hand);
  const ranks = [...groups.keys()].sort((a, b) => a - b);
  const moves = [];
  const push = (cards) => {
    if (!cards) return;
    const pattern = primaryPattern(cards, mode);
    if (pattern) moves.push({ cards, pattern });
  };
  const kickers = (exclude, size, count) => {
    const pool = ranks.filter((r) => !exclude.has(r) && groups.get(r).length >= size && r < RANK_SMALL_JOKER).sort((a, b) => groups.get(a).length - groups.get(b).length || a - b);
    if (pool.length < count) return null;
    return pool.slice(0, count).flatMap((r) => groups.get(r).slice(0, size));
  };
  for (const r of ranks) {
    const g = groups.get(r);
    push([g[0]]);
    if (g.length >= 2) push(g.slice(0, 2));
    if (g.length >= 3) {
      const t = g.slice(0, 3);
      push(t);
      const one = kickers(/* @__PURE__ */ new Set([r]), 1, 1);
      if (one) push([...t, ...one]);
      const two = kickers(/* @__PURE__ */ new Set([r]), 2, 1);
      if (two) push([...t, ...two]);
    }
    for (let size = 4; size <= g.length; size++) push(g.slice(0, size));
    if (mode === "doudizhu" && g.length === 4) {
      const ones = kickers(/* @__PURE__ */ new Set([r]), 1, 2);
      if (ones) push([...g, ...ones]);
      const twos = kickers(/* @__PURE__ */ new Set([r]), 2, 2);
      if (twos) push([...g, ...twos]);
    }
  }
  const seqRanks = ranks.filter((r) => r <= MAX_SEQ_RANK);
  const runs = (minCount, minLen, take) => {
    for (let i = 0; i < seqRanks.length; i++) {
      const seq = [];
      for (let j = i; j < seqRanks.length; j++) {
        if (groups.get(seqRanks[j]).length < minCount) break;
        if (seq.length && seqRanks[j] !== seq[seq.length - 1] + 1) break;
        seq.push(seqRanks[j]);
        if (seq.length >= minLen) {
          const base = seq.flatMap((r) => groups.get(r).slice(0, take));
          push(base);
          if (take === 3) {
            const ex = new Set(seq);
            const ones = kickers(ex, 1, seq.length);
            if (ones) push([...base, ...ones]);
            const twos = kickers(ex, 2, seq.length);
            if (twos) push([...base, ...twos]);
          }
        }
      }
    }
  };
  runs(1, 5, 1);
  runs(2, 3, 2);
  runs(3, 2, 3);
  const jokers = hand.filter((c) => c.rank >= RANK_SMALL_JOKER);
  if (jokers.some((c) => c.rank === RANK_SMALL_JOKER) && jokers.some((c) => c.rank === RANK_BIG_JOKER)) {
    push(jokers);
  }
  return moves;
}
function moveCost(move, hand) {
  const groups = groupByRank(hand);
  let cost = move.pattern.mainRank * 2;
  const used = /* @__PURE__ */ new Map();
  for (const c of move.cards) used.set(c.rank, (used.get(c.rank) ?? 0) + 1);
  for (const [r, n] of used) {
    const total = groups.get(r).length;
    if (n < total) {
      cost += total >= 4 ? 40 : total === 3 ? 8 : 4;
    }
  }
  if (isBombLike(move.pattern)) cost += 60 + move.pattern.power / 20;
  if (move.pattern.type === "four_two_single" || move.pattern.type === "four_two_pair") cost += 30;
  cost -= move.cards.length * 3;
  return cost;
}
function legalMoves(hand, target, mode) {
  return generateMoves(hand, mode).map((m) => {
    const p = analyze(m.cards, mode).find((x) => beats(x, target));
    return p ? { cards: m.cards, pattern: p } : null;
  }).filter((m) => m !== null);
}
function decideMove(ctx) {
  const { hand, target } = ctx;
  const mode = ctx.mode ?? "paodekuai";
  const level = ctx.level ?? "normal";
  if (hand.length === 0) return null;
  const whole = analyze(hand, mode);
  if (whole.length && (!target || whole.some((p2) => beats(p2, target)))) return hand;
  const moves = generateMoves(hand, mode);
  const danger = ctx.minOpponentCards <= (level === "hard" ? 3 : 2);
  const p = ctx.personality ?? { aggression: 0.5, patience: 0.5, mistake: 0.04 };
  const mem = p.memory ?? {};
  const oppWeak = (mem.oppPassRate ?? 0.3) > 0.45;
  const oppAggro = (mem.oppBigRate ?? 0.2) > 0.45;
  const oppStrong = (mem.oppWinRate ?? 0.33) > 0.5;
  const aggr = Math.max(0, Math.min(
    1,
    p.aggression + (oppWeak ? 0.2 : 0) - (oppAggro ? 0.15 : 0) - (oppStrong ? 0.1 : 0)
  ));
  const played = ctx.played ?? [];
  const bigRanks = [13, 14, 15, RANK_SMALL_JOKER, RANK_BIG_JOKER];
  const bigTotal = hand.filter((c) => bigRanks.includes(c.rank)).length;
  const bigPlayed = played.filter((c) => bigRanks.includes(c.rank)).length;
  const bigOutside = Math.max(0, 12 - bigTotal - bigPlayed);
  const outsideWeak = bigOutside <= 2;
  const slip = Math.random() < (p.mistake ?? 0.04);
  if (!target) {
    let candidates = moves.filter((m) => !isBombLike(m.pattern));
    if (!candidates.length) candidates = moves;
    if (ctx.nextIsTeammate && ctx.nextPlayerCards <= 2) {
      const sorted = sortByRank(hand);
      const singles = candidates.filter((m) => m.pattern.type === "single");
      if (singles.length) return singles.sort((a, b) => a.pattern.mainRank - b.pattern.mainRank)[0].cards;
      return [sorted[0]];
    }
    if (ctx.nextPlayerCards === 1 && !ctx.nextIsTeammate) {
      const nonSingle = candidates.filter((m) => m.pattern.type !== "single");
      if (nonSingle.length) candidates = nonSingle;
      else return [sortByRank(hand)[hand.length - 1]];
    }
    if (slip) return candidates[Math.floor(Math.random() * candidates.length)].cards;
    candidates.sort((a, b) => moveCost(a, hand) - moveCost(b, hand));
    if (aggr > 0.65 && candidates.length > 1) {
      const big = [...candidates].sort((a, b) => b.cards.length - a.cards.length || b.pattern.power - a.pattern.power);
      return big[0].cards;
    }
    if (outsideWeak && candidates.length > 1) {
      const mid = [...candidates].sort((a, b) => b.pattern.mainRank - a.pattern.mainRank);
      return mid[0].cards;
    }
    if (aggr < 0.35 && candidates.length > 1) {
      const small = [...candidates].sort((a, b) => a.pattern.power - b.pattern.power);
      return small[0].cards;
    }
    return candidates[0].cards;
  }
  if (ctx.teammateOnTop) {
    if (!(danger && target.mainRank < 12 && level === "hard")) return null;
  }
  const legal = legalMoves(hand, target, mode);
  if (!legal.length) return null;
  if (level === "easy" && Math.random() < 0.3) return null;
  const normal = legal.filter((m) => !isBombLike(m.pattern));
  if (normal.length) {
    if (!ctx.nextIsTeammate && ctx.nextPlayerCards === 1 && !ctx.teammateOnTop) {
      const maxed = [...normal].sort((a, b) => b.pattern.power - a.pattern.power);
      return maxed[0].cards;
    }
    normal.sort((a, b) => moveCost(a, hand) - moveCost(b, hand));
    const best = normal[0];
    const holdChance = danger ? 0.05 : (0.2 + p.patience * 0.55) * (level === "hard" ? 0.6 : 1);
    if (!danger && best.pattern.mainRank >= RANK_TWO && hand.length > 8 && Math.random() < holdChance) return null;
    return best.cards;
  }
  const bombChance = level === "easy" ? 0.1 : level === "hard" ? 0.15 : 0.25;
  if (danger || hand.length <= 6 || Math.random() < bombChance) {
    legal.sort((a, b) => a.pattern.power - b.pattern.power);
    return legal[0].cards;
  }
  return null;
}
function handStrength(hand) {
  const groups = groupByRank(hand);
  let score = 0;
  for (const [rank2, cards] of groups) {
    if (rank2 === RANK_BIG_JOKER) score += 4 * cards.length;
    else if (rank2 === RANK_SMALL_JOKER) score += 3 * cards.length;
    else if (rank2 === RANK_TWO) score += 2 * cards.length;
    else if (rank2 === 14) score += cards.length;
    if (cards.length >= 4) score += 4;
  }
  if (groups.has(RANK_BIG_JOKER) && groups.has(RANK_SMALL_JOKER)) score += 2;
  return score;
}
function decideBid(hand, someoneCalled, level = "normal") {
  const s = handStrength(hand) + (level === "easy" ? Math.random() * 4 - 2 : 0);
  return someoneCalled ? s >= (level === "hard" ? 8 : 9) : s >= 6;
}

// src/game/engine.ts
var GameError = class extends Error {
};
function bottomCount(players) {
  return players === 3 ? 3 : 8;
}
function dealNewGame(opts, now = Date.now()) {
  const { seats } = opts;
  const mode = opts.mode ?? "paodekuai";
  if (seats.length < 3) throw new GameError("\u81F3\u5C11\u9700\u8981 3 \u540D\u73A9\u5BB6");
  if (mode === "doudizhu" && seats.length > 4) throw new GameError("\u6597\u5730\u4E3B\u652F\u6301 3\uFF5E4 \u4EBA");
  let deck = shuffle(createDecks(opts.deckCount, mode === "doudizhu" ? true : opts.withJokers));
  if (mode !== "doudizhu") {
    const noJoker = deck.filter((c) => c.suit !== "J");
    const twos = shuffle(noJoker.filter((c) => c.rank === 15));
    const aces = shuffle(noJoker.filter((c) => c.rank === 14));
    const rest = noJoker.filter((c) => c.rank !== 15 && c.rank !== 14);
    deck = shuffle([...rest, ...twos.slice(0, 1), ...aces.slice(0, 3)]);
  }
  const reserve = mode === "doudizhu" ? bottomCount(seats.length) : 0;
  const perPlayer = Math.floor((deck.length - reserve) / seats.length);
  const hands = {};
  seats.forEach((s) => hands[s.id] = []);
  for (let i = 0; i < perPlayer * seats.length; i++) {
    hands[seats[i % seats.length].id].push(deck[i]);
  }
  for (const s of seats) hands[s.id] = sortByRank(hands[s.id]);
  const leftover = sortByRank(deck.slice(perPlayer * seats.length));
  let turn = seats.findIndex((s) => s.id === opts.previousWinnerId);
  if (turn < 0) {
    if (mode === "doudizhu") {
      turn = Math.floor(Math.random() * seats.length);
    } else {
      let best = null;
      seats.forEach((s, i) => {
        const c = hands[s.id][0];
        if (c && (!best || compareCards(c, best) < 0)) {
          best = c;
          turn = i;
        }
      });
    }
  }
  return {
    mode,
    round: opts.round,
    phase: mode === "doudizhu" ? "bidding" : "playing",
    seats,
    hands,
    leftover,
    turn: Math.max(0, turn),
    lastPlay: null,
    seatActions: {},
    passCount: 0,
    bombs: 0,
    log: [],
    bidding: mode === "doudizhu" ? { candidate: null, calls: {}, count: 0, allPassed: false } : null,
    landlordSeat: null,
    finishOrder: [],
    winnerSeat: null,
    winners: null,
    settlement: null,
    startedAt: now,
    turnStartedAt: now
  };
}
function seatIndexOf(state, playerId) {
  return state.seats.findIndex((s) => s.id === playerId);
}
function isOut(state, seat) {
  return state.finishOrder.includes(seat);
}
function nextSeat(state, seat) {
  const n = state.seats.length;
  for (let k = 1; k <= n; k++) {
    const s = (seat + k) % n;
    if (!isOut(state, s)) return s;
  }
  return seat;
}
function isTeammate(state, a, b) {
  if (a === b) return true;
  if (state.mode !== "doudizhu" || state.landlordSeat === null) return false;
  return a !== state.landlordSeat && b !== state.landlordSeat;
}
function placeBid(state, playerId, call, now = Date.now()) {
  if (state.phase !== "bidding" || !state.bidding) throw new GameError("\u5F53\u524D\u4E0D\u662F\u53EB\u5730\u4E3B\u9636\u6BB5");
  const seat = seatIndexOf(state, playerId);
  if (seat !== state.turn) throw new GameError("\u8FD8\u6CA1\u8F6E\u5230\u4F60");
  if (now < state.turnStartedAt) throw new GameError("\u6B63\u5728\u53D1\u724C\uFF0C\u8BF7\u7A0D\u5019");
  const b = state.bidding;
  const grab = b.candidate !== null;
  const bidding = {
    ...b,
    calls: { ...b.calls, [seat]: call },
    count: b.count + 1,
    candidate: call ? seat : b.candidate
  };
  const next = {
    ...state,
    bidding,
    seatActions: { ...state.seatActions, [seat]: { kind: "bid", called: call, grab, at: now } },
    turnStartedAt: now
  };
  if (bidding.count >= state.seats.length) {
    if (bidding.candidate === null) return { ...next, bidding: { ...bidding, allPassed: true } };
    return assignLandlord(next, bidding.candidate, now);
  }
  next.turn = (seat + 1) % state.seats.length;
  return next;
}
function assignLandlord(state, seat, now) {
  const id = state.seats[seat].id;
  return {
    ...state,
    phase: "playing",
    landlordSeat: seat,
    hands: { ...state.hands, [id]: sortByRank([...state.hands[id], ...state.leftover]) },
    turn: seat,
    seatActions: {},
    turnStartedAt: now
  };
}
function playCards(state, playerId, cardIds, now = Date.now()) {
  if (state.phase === "bidding") throw new GameError("\u6B63\u5728\u53EB\u5730\u4E3B");
  if (state.phase !== "playing") throw new GameError("\u672C\u5C40\u5DF2\u7ED3\u675F");
  const seat = seatIndexOf(state, playerId);
  if (seat !== state.turn) throw new GameError("\u8FD8\u6CA1\u8F6E\u5230\u4F60\u51FA\u724C");
  if (now < state.turnStartedAt) throw new GameError("\u6B63\u5728\u53D1\u724C\uFF0C\u8BF7\u7A0D\u5019");
  if (!cardIds.length) throw new GameError("\u8BF7\u9009\u62E9\u8981\u51FA\u7684\u724C");
  const hand = state.hands[playerId];
  const idSet = new Set(cardIds);
  const cards = hand.filter((c) => idSet.has(c.id));
  if (cards.length !== idSet.size) throw new GameError("\u6240\u9009\u7684\u724C\u4E0D\u5728\u624B\u724C\u4E2D");
  const pattern = resolvePlay(cards, state.lastPlay?.pattern ?? null, state.mode);
  if (!pattern) {
    throw new GameError(state.lastPlay ? "\u51FA\u724C\u5FC5\u987B\u662F\u540C\u724C\u578B\u4E14\u66F4\u5927\uFF0C\u6216\u4F7F\u7528\u70B8\u5F39" : "\u4E0D\u662F\u5408\u6CD5\u7684\u724C\u578B");
  }
  const rest = hand.filter((c) => !idSet.has(c.id));
  const sorted = sortByRank(cards);
  const next = {
    ...state,
    hands: { ...state.hands, [playerId]: rest },
    lastPlay: { seat, cards: sorted, pattern },
    seatActions: { ...state.seatActions, [seat]: { kind: "play", cards: sorted, pattern, at: now } },
    passCount: 0,
    bombs: state.bombs + (isBombLike(pattern) ? 1 : 0),
    log: [...state.log, { seat, action: "play", cards: sorted, pattern, at: now }],
    turnStartedAt: now
  };
  if (rest.length === 0) {
    next.finishOrder = [...state.finishOrder, seat];
    if (next.winnerSeat === null) next.winnerSeat = seat;
    if (state.mode === "doudizhu" || next.finishOrder.length >= 1) return finishGame(next);
  }
  next.turn = nextSeat(next, seat);
  next.seatActions = { ...next.seatActions, [next.turn]: void 0 };
  return next;
}
function passTurn(state, playerId, now = Date.now()) {
  if (state.phase !== "playing") throw new GameError(state.phase === "bidding" ? "\u6B63\u5728\u53EB\u5730\u4E3B" : "\u672C\u5C40\u5DF2\u7ED3\u675F");
  const seat = seatIndexOf(state, playerId);
  if (seat !== state.turn) throw new GameError("\u8FD8\u6CA1\u8F6E\u5230\u4F60");
  if (!state.lastPlay) throw new GameError("\u4F60\u662F\u672C\u8F6E\u9996\u4E2A\u51FA\u724C\u8005\uFF0C\u4E0D\u80FD\u8FC7\u724C");
  const passCount = state.passCount + 1;
  const next = {
    ...state,
    passCount,
    seatActions: { ...state.seatActions, [seat]: { kind: "pass", at: now } },
    log: [...state.log, { seat, action: "pass", at: now }],
    turnStartedAt: now
  };
  const owner = state.lastPlay.seat;
  const responders = state.seats.filter((_, i) => i !== owner && !isOut(state, i)).length;
  if (passCount >= responders) {
    next.turn = isOut(state, owner) ? nextSeat(state, owner) : owner;
    next.lastPlay = null;
    next.passCount = 0;
    next.seatActions = {};
  } else {
    next.turn = nextSeat(state, seat);
    next.seatActions = { ...next.seatActions, [next.turn]: void 0 };
  }
  return next;
}
function finishGame(state) {
  let winners;
  const rankOf = {};
  if (state.mode === "doudizhu") {
    const landlord = state.landlordSeat;
    const farmers = state.seats.map((_, i) => i).filter((i) => i !== landlord);
    winners = state.winnerSeat === landlord ? [landlord] : farmers;
    winners.forEach((w) => rankOf[w] = 1);
    const losers = state.seats.map((_, i) => i).filter((i) => !winners.includes(i)).sort((a, b) => state.hands[state.seats[a].id].length - state.hands[state.seats[b].id].length);
    let r = 2;
    losers.forEach((l) => rankOf[l] = r++);
  } else {
    winners = [state.finishOrder[0]];
    state.finishOrder.forEach((s, i) => rankOf[s] = i + 1);
    const rest = state.seats.map((_, i) => i).filter((i) => rankOf[i] === void 0).sort((a, b) => {
      const d = state.hands[state.seats[a].id].length - state.hands[state.seats[b].id].length;
      return d !== 0 ? d : a - b;
    });
    let r = state.finishOrder.length + 1;
    rest.forEach((s) => rankOf[s] = r++);
  }
  const rows = state.seats.map((s, i) => ({
    playerId: s.id,
    name: s.name,
    remaining: state.hands[s.id].length,
    rank: rankOf[i],
    role: state.mode === "doudizhu" ? i === state.landlordSeat ? "landlord" : "farmer" : void 0
  }));
  rows.sort((a, b) => a.rank - b.rank || a.remaining - b.remaining);
  return { ...state, phase: "finished", winners, settlement: rows, turn: state.winnerSeat ?? state.turn };
}
function viewFor(state, playerId) {
  const { hands, leftover, ...rest } = state;
  const handCounts = {};
  for (const s of state.seats) handCounts[s.id] = hands[s.id].length;
  const finished = state.phase === "finished";
  const showBottom = finished || state.mode === "doudizhu" && state.phase !== "bidding";
  return {
    ...rest,
    myHand: playerId ? hands[playerId] ?? [] : [],
    handCounts,
    revealedHands: finished ? hands : null,
    leftoverCount: leftover.length,
    leftover: showBottom ? leftover : null
  };
}

// src/net/adminHistory.ts
function buildRecord(room, g) {
  const initialHands = {};
  for (const s of g.seats) initialHands[s.id] = [...g.hands[s.id]];
  for (const l of g.log) if (l.action === "play") initialHands[g.seats[l.seat].id].push(...l.cards);
  return {
    id: `${room.code}-${g.round}-${g.startedAt}`,
    roomCode: room.code,
    mode: g.mode,
    round: g.round,
    startedAt: g.startedAt,
    endedAt: g.log[g.log.length - 1]?.at ?? Date.now(),
    deckCount: room.config.deckCount,
    withJokers: g.mode === "doudizhu" ? true : room.config.withJokers,
    players: g.seats.map((s) => ({ id: s.id, name: s.name, kind: room.players.find((p) => p.id === s.id)?.kind ?? (s.isAI ? "ai" : "human") })),
    winnerSeat: g.winnerSeat,
    winners: g.winners ?? [g.winnerSeat],
    finishOrder: g.finishOrder,
    landlordSeat: g.landlordSeat,
    bombs: g.bombs,
    settlement: g.settlement,
    initialHands,
    bottom: g.leftover,
    calls: g.bidding?.calls ?? null,
    log: g.log
  };
}

// src/net/roomServer.ts
init_rtcfg();

// src/net/protocol.ts
var MIN_PLAYERS = 3;
var MAX_PLAYERS = 8;
var MIN_CARDS_PER_PLAYER = 5;
var DEAL_ANIMATION_MS = 8400;
var LANDLORD_REVEAL_MS = 2200;
function defaultConfig() {
  return { mode: "paodekuai", aiLevel: "normal", seatCount: 3, autoSeats: true, deckCount: 1, deckManual: false, withJokers: true, turnSeconds: 30, chat: "full" };
}

// src/net/roomServer.ts
var OFFLINE_AFTER_MS = 6e3;
var OFFLINE_TURN_GRACE_MS = 3e3;
var AI_NAMES = [
  "\u94C1\u67F1\u54E5",
  "\u80D6\u864E\u5144",
  "\u5B64\u72EC\u60A3\u8005",
  "\u6D6A\u8FF9\u5929\u6DAF",
  "\u6C5F\u6E56\u6D6A\u5B50",
  "\u72EC\u6765\u72EC\u5F80",
  "\u4ECA\u665A\u5403\u9E21",
  "\u5E78\u8FD0\u661F66",
  "\u5927\u5409\u5927\u52298",
  "liuyang666"
];
var SIM_NAMES = [
  "\u5F80\u4E8B\u968F\u98CE",
  "\u7B11\u770B\u4EBA\u751F",
  "\u8D22\u8FD0\u4EA8\u901A",
  "\u4E00\u8DEF\u53D1",
  "\u5927\u6740\u56DB\u65B9",
  "\u8D4C\u795E\u5728\u4E16",
  "\u7A33\u4E2D\u6C42\u80DC",
  "\u987A\u5176\u81EA\u7136",
  "\u6DE1\u5FD8\u4E00\u5207",
  "\u8FFD\u98CE\u5C11\u5E74",
  "\u5B64\u72EC\u60A3\u8005",
  "\u6D6A\u8FF9\u5929\u6DAF",
  "\u591C\u732B\u5B50",
  "\u4ECA\u665A\u5403\u9E21",
  "\u4E0D\u670D\u5C31\u5E72",
  "\u5E38\u80DC\u5C06\u519B",
  "\u6C5F\u6E56\u6D6A\u5B50",
  "\u72EC\u6765\u72EC\u5F80",
  "\u8001\u5F20888",
  "\u963F\u826F9527",
  "\u5C0F\u80D6123",
  "\u94C1\u67F1\u54E5",
  "\u4E8C\u72D7\u5B50",
  "\u80D6\u864E\u5144",
  "\u73A9\u5BB68823",
  "\u7528\u62376677",
  "\u5E78\u8FD0\u661F66",
  "\u5927\u5409\u5927\u52298",
  "5201314",
  "8888888",
  "13966558822",
  "wangwei88",
  "liuyang666",
  "qq882399",
  "zhanghao520",
  "chenjie123"
];
var CHAT_KEEP = 30;
var CHAT_MIN_INTERVAL_MS = 1500;
var CHAT_BURST = { count: 5, windowMs: 15e3 };
var VIOLATIONS_TO_MUTE = 3;
var MUTE_MS = 2 * 60 * 1e3;
var HOST_HANDOVER_MS = 30 * 1e3;
function randomId(prefix = "p") {
  return prefix + "_" + Math.random().toString(36).slice(2, 10);
}
var balanceFetcher = null;
function setBalanceFetcher(fn) {
  balanceFetcher = fn;
}
var RoomServer = class _RoomServer {
  room;
  game;
  listeners = /* @__PURE__ */ new Map();
  timer = null;
  pendingAutoAt = null;
  version = 0;
  closed = false;
  /**
   * 房主是否就是"服务器"本身（本地模拟模式）。
   * 真实后端中房主只是普通客户端：同样按心跳判断在线，长时间离线会自动移交房主。
   */
  hostIsServer = true;
  /** 状态变更回调（持久化、更新房间列表） */
  onChange = null;
  /** 每局结束回调（写入后台历史记录） */
  onRoundFinished = null;
  /** 游戏中主动离开时触发（用于扣房间费） */
  onPlayerLeaveMidGame = null;
  /** 拦截到违规聊天时回调（后端写入数据库） */
  onModeration = null;
  /** 被拦截的聊天记录（只进入后台概要，不推送给玩家） */
  moderation = [];
  chatTimes = /* @__PURE__ */ new Map();
  violations = /* @__PURE__ */ new Map();
  mutedUntil = /* @__PURE__ */ new Map();
  constructor(snapshot) {
    this.room = snapshot.room;
    this.room.config = { ...defaultConfig(), ...this.room.config };
    delete this.room.history;
    delete this.room.scores;
    this.room.chat ??= [];
    this.game = snapshot.game;
  }
  static create(code, hostId, hostName, config, ip, fp) {
    const now = Date.now();
    const room = {
      code,
      hostId,
      createdAt: now,
      config: { ...defaultConfig(), ...config },
      players: [
        { id: hostId, name: hostName, kind: "human", isHost: true, online: true, ready: true, autoPlay: false, joinedAt: now, lastSeen: now, latency: 0, ip, fp }
      ],
      status: "waiting",
      round: 0,
      lastWinnerId: null,
      chat: []
    };
    const server = new _RoomServer({ room, game: null });
    server.normalizeConfig();
    return server;
  }
  start() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 400);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  destroy(reason = "\u623F\u95F4\u5DF2\u5173\u95ED") {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const l of this.listeners.values()) l({ type: "closed", reason });
    this.listeners.clear();
  }
  snapshot() {
    return { room: this.room, game: this.game };
  }
  /** 玩家连接（收到推送）。返回断开函数 */
  connect(playerId, listener) {
    this.listeners.set(playerId, listener);
    this.sendState(playerId);
    return () => {
      if (this.listeners.get(playerId) === listener) this.listeners.delete(playerId);
    };
  }
  /** 主动推送一次状态给所有连接（结算后刷新金额用） */
  /** 把输赢金额写进当前局的结算行 */
  applyDeltas(deltas) {
    const g = this.game;
    if (!g || !g.settlement) return;
    const map2 = new Map(deltas.map((d) => [d.uid, d.delta]));
    for (const r of g.settlement) {
      const v = map2.get(r.playerId);
      if (typeof v === "number") r.delta = v;
    }
  }
  system(message) {
    for (const listener of this.listeners.values()) listener({ type: "error", message });
  }
  broadcastAll() {
    for (const [pid] of this.listeners) {
      try {
        this.sendState(pid);
      } catch {
      }
    }
  }
  isMember(playerId) {
    return this.room.players.some((p) => p.id === playerId);
  }
  // ---------------------------------------------------------------- 消息处理
  /** 跨局记忆：玩家历史胜负 */
  playerWins = /* @__PURE__ */ new Map();
  /** 机器人情绪：负=连败，正=连胜 */
  botMood = /* @__PURE__ */ new Map();
  /** 时段因子：深夜反应更慢 */
  hourFactor() {
    const h = (/* @__PURE__ */ new Date()).getHours();
    if (h >= 1 && h < 6) return 1.7;
    if (h >= 6 && h < 9) return 1.25;
    if (h >= 23) return 1.35;
    return 1;
  }
  /** 玩家行为统计（用于 AI 学习）：过牌次数 / 总行动 / 出大牌次数 */
  playerStats = /* @__PURE__ */ new Map();
  /** 每个机器人的固定性格（用 id 哈希，重启也不变） */
  /** 机器人虚拟余额（按 id 哈希稳定，500~5000） */
  virtualBalance(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = h * 31 + id.charCodeAt(i) | 0;
    const base = 500 + Math.abs(h % 4500);
    return Math.round(base * 100) / 100;
  }
  botPersona(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = h * 31 + id.charCodeAt(i) | 0;
    const r = (n) => Math.abs((h >> n) % 100) / 100;
    const mood = this.botMood.get(id) ?? 0;
    const moodAggr = mood < 0 ? Math.min(0.25, Math.abs(mood) * 0.08) : mood > 0 ? -Math.min(0.2, mood * 0.07) : 0;
    return {
      aggression: Math.max(0, Math.min(1, r(0) + moodAggr)),
      patience: Math.max(0, Math.min(1, r(4) - moodAggr * 0.6)),
      mistake: 0.02 + r(8) * 0.1,
      memory: { ...this.oppMemory(id), oppWinRate: this.oppWinRate(id) }
    };
  }
  /** 对手胜率（跨局记忆）：赢得多说明强 */
  oppWinRate(botId) {
    let win = 0, total = 0;
    for (const [uid, st] of this.playerWins) {
      if (uid === botId) continue;
      win += st.win;
      total += st.total;
    }
    return total ? win / total : 0.33;
  }
  /** 从玩家统计里算出对手画像 */
  oppMemory(botId) {
    let pass = 0, total = 0, big = 0;
    for (const [uid, st] of this.playerStats) {
      if (uid === botId) continue;
      pass += st.pass;
      total += st.total;
      big += st.big;
    }
    if (!total) return { oppPassRate: 0.3, oppBigRate: 0.2 };
    return { oppPassRate: pass / total, oppBigRate: big / Math.max(1, total - pass) };
  }
  /** 记录一次行动（用于学习） */
  noteAction(uid, played, cardCount) {
    const st = this.playerStats.get(uid) ?? { pass: 0, total: 0, big: 0 };
    st.total += 1;
    if (!played) st.pass += 1;
    else if (cardCount >= 5) st.big += 1;
    this.playerStats.set(uid, st);
  }
  /** 已扣过房间费的玩家（防重复 leave 重复扣费） */
  chargedLeavers = /* @__PURE__ */ new Set();
  /** 消息频率窗口：防脚本高频刷操作 */
  msgWindow = /* @__PURE__ */ new Map();
  /** 上一手操作时间：防机器级操作速度 */
  lastAct = /* @__PURE__ */ new Map();
  handle(playerId, msg) {
    try {
      const now = Date.now();
      const w = this.msgWindow.get(playerId);
      if (!w || now - w.at > 1e3) {
        this.msgWindow.set(playerId, { count: 1, at: now });
      } else {
        w.count += 1;
        if (w.count > rtCfg().msgRate) throw new GameError("\u64CD\u4F5C\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
      }
      if (msg.type === "play" || msg.type === "bid" || msg.type === "pass") {
        const prev = this.lastAct.get(playerId) ?? 0;
        if (prev && now - prev < rtCfg().actMs) throw new GameError("\u64CD\u4F5C\u8FC7\u5FEB\uFF0C\u8BF7\u653E\u6162\u901F\u5EA6");
        this.lastAct.set(playerId, now);
      }
      this.dispatch(playerId, msg);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.listeners.get(playerId)?.({ type: "error", message });
    }
  }
  dispatch(playerId, msg) {
    const now = Date.now();
    if (msg.type === "join") return this.join(playerId, msg.name);
    const me = this.room.players.find((p) => p.id === playerId);
    if (!me) throw new GameError("\u4F60\u4E0D\u5728\u8BE5\u623F\u95F4\u4E2D");
    me.lastSeen = now;
    const wasOffline = !me.online;
    me.online = true;
    const isHost = playerId === this.room.hostId;
    switch (msg.type) {
      case "heartbeat":
        me.latency = Math.max(1, now - msg.sentAt);
        if (wasOffline) this.changed();
        else this.sendState(playerId);
        return;
      case "leave":
        return this.leave(me);
      case "ready":
        if (this.room.status === "playing") throw new GameError("\u6E38\u620F\u8FDB\u884C\u4E2D");
        me.ready = isHost ? true : msg.ready;
        return this.changed();
      case "config":
        this.requireHost(isHost);
        if (this.room.status === "playing") throw new GameError("\u6E38\u620F\u8FDB\u884C\u4E2D\u4E0D\u80FD\u4FEE\u6539\u8BBE\u7F6E");
        this.room.config = { ...this.room.config, ...msg.patch };
        if (msg.patch.deckCount !== void 0) this.room.config.deckManual = true;
        if (msg.patch.seatCount !== void 0) this.room.config.autoSeats = false;
        this.normalizeConfig();
        return this.changed();
      case "addSimulated":
        this.requireHost(isHost);
        return this.addSimulated();
      case "kick":
        throw new GameError("\u5F53\u524D\u4E0D\u652F\u6301\u79FB\u51FA\u73A9\u5BB6");
      case "start":
        this.requireHost(isHost);
        if (this.room.status !== "waiting") throw new GameError("\u6E38\u620F\u5DF2\u7ECF\u5F00\u59CB");
        return this.startRound();
      case "nextRound":
        this.requireHost(isHost);
        if (this.room.status !== "finished") throw new GameError("\u672C\u5C40\u5C1A\u672A\u7ED3\u675F");
        return this.startRound();
      case "backToLobby":
        this.requireHost(isHost);
        if (this.room.status === "playing") throw new GameError("\u6E38\u620F\u8FDB\u884C\u4E2D");
        this.room.status = "waiting";
        this.game = null;
        this.room.players = this.room.players.filter((p) => p.kind !== "ai");
        for (const p of this.room.players) if (p.kind === "human" && !p.isHost) p.ready = false;
        this.normalizeConfig();
        return this.changed();
      case "play":
        this.requireGame();
        this.game = playCards(this.game, playerId, msg.cardIds);
        return this.afterMove();
      case "pass":
        this.requireGame();
        this.game = passTurn(this.game, playerId);
        return this.afterMove();
      case "bid":
        this.requireGame();
        this.game = placeBid(this.game, playerId, msg.call);
        return this.afterMove("bidding");
      case "autoPlay":
        me.autoPlay = msg.on;
        return this.changed();
      case "chat":
        return this.chat(me, msg.kind, msg.content, now);
    }
  }
  // ---------------------------------------------------------------- 聊天
  chat(me, kind, content, now) {
    const policy = this.room.config.chat;
    if (policy === "off") throw new GameError("\u623F\u4E3B\u5DF2\u5173\u95ED\u804A\u5929");
    const muted = this.mutedUntil.get(me.id) ?? 0;
    if (now < muted) throw new GameError(`\u4F60\u5DF2\u88AB\u7981\u8A00\uFF0C${Math.ceil((muted - now) / 1e3)} \u79D2\u540E\u53EF\u518D\u6B21\u53D1\u8A00`);
    const times = (this.chatTimes.get(me.id) ?? []).filter((t) => now - t < CHAT_BURST.windowMs);
    if (times.length && now - times[times.length - 1] < CHAT_MIN_INTERVAL_MS) throw new GameError("\u53D1\u8A00\u592A\u5FEB\u4E86\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
    if (times.length >= CHAT_BURST.count) throw new GameError("\u53D1\u8A00\u592A\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
    let text;
    if (kind === "phrase") {
      if (!QUICK_PHRASES.includes(content)) throw new GameError("\u65E0\u6548\u7684\u77ED\u8BED");
      text = content;
    } else if (kind === "emoji") {
      if (!EMOJIS.includes(content)) throw new GameError("\u65E0\u6548\u7684\u8868\u60C5");
      text = content;
    } else {
      if (policy !== "full") throw new GameError("\u623F\u4E3B\u53EA\u5141\u8BB8\u53D1\u9001\u5FEB\u6377\u77ED\u8BED\u548C\u8868\u60C5");
      const result = checkText(content);
      if (!result.ok) {
        this.recordViolation(me, content, result.reason, now);
        const mutedNow = (this.mutedUntil.get(me.id) ?? 0) > now;
        throw new GameError(mutedNow ? `${result.reason}\u3002\u591A\u6B21\u8FDD\u89C4\uFF0C\u5DF2\u88AB\u7981\u8A00 2 \u5206\u949F` : result.reason);
      }
      text = result.text;
    }
    this.chatTimes.set(me.id, [...times, now]);
    this.room.chat = [...this.room.chat, { id: randomId("m"), playerId: me.id, name: me.name, kind, content: text, at: now }].slice(-CHAT_KEEP);
    this.changed();
  }
  recordViolation(me, content, reason, now) {
    this.moderation = [{ playerId: me.id, name: me.name, content: content.slice(0, 40), reason, at: now }, ...this.moderation].slice(0, 50);
    const recent = [...(this.violations.get(me.id) ?? []).filter((t) => now - t < 5 * 60 * 1e3), now];
    this.violations.set(me.id, recent);
    if (recent.length >= VIOLATIONS_TO_MUTE) {
      this.mutedUntil.set(me.id, now + MUTE_MS);
      this.violations.set(me.id, []);
      this.moderation[0].reason += "\uFF08\u5DF2\u81EA\u52A8\u7981\u8A00 2 \u5206\u949F\uFF09";
    }
    this.onModeration?.(this.moderation[0]);
    this.onChange?.(this);
  }
  requireHost(isHost) {
    if (!isHost) throw new GameError("\u53EA\u6709\u623F\u4E3B\u53EF\u4EE5\u6267\u884C\u6B64\u64CD\u4F5C");
  }
  requireGame() {
    if (!this.game || this.room.status !== "playing") throw new GameError("\u6E38\u620F\u672A\u5F00\u59CB");
  }
  humans() {
    return this.room.players.filter((p) => p.kind !== "ai");
  }
  capacity() {
    const max = this.room.config.mode === "doudizhu" ? 4 : MAX_PLAYERS;
    return this.room.config.autoSeats ? max : Math.min(max, this.room.config.seatCount);
  }
  join(playerId, name) {
    const now = Date.now();
    const existing = this.room.players.find((p) => p.id === playerId);
    if (existing) {
      existing.online = true;
      existing.lastSeen = now;
      this.listeners.get(playerId)?.({ type: "joined", playerId, code: this.room.code });
      return this.changed();
    }
    if (this.room.status !== "waiting") throw new GameError("\u6E38\u620F\u8FDB\u884C\u4E2D\uFF0C\u6682\u65F6\u65E0\u6CD5\u52A0\u5165");
    if (this.humans().length >= this.capacity()) throw new GameError("\u623F\u95F4\u5DF2\u6EE1");
    const clean = name.trim().slice(0, 12) || "\u73A9\u5BB6";
    if (containsBlocked(clean)) throw new GameError("\u6635\u79F0\u5305\u542B\u4E0D\u6587\u660E\u5185\u5BB9\uFF0C\u8BF7\u4FEE\u6539\u540E\u518D\u52A0\u5165");
    this.room.players.push({
      id: playerId,
      name: this.uniqueName(clean),
      kind: "human",
      isHost: false,
      online: true,
      ready: false,
      autoPlay: false,
      joinedAt: now,
      lastSeen: now,
      latency: 0
    });
    this.normalizeConfig();
    this.listeners.get(playerId)?.({ type: "joined", playerId, code: this.room.code });
    this.changed();
  }
  leave(me) {
    if (me.isHost) {
      if (this.room.status === "playing" && me.kind === "human" && !this.chargedLeavers.has(me.id)) {
        this.chargedLeavers.add(me.id);
        const pay = this.leavePayInfo(me.id);
        try {
          this.onPlayerLeaveMidGame?.(me.id, me.name, pay.mult, pay.role);
        } catch {
        }
      }
      this.destroy("\u623F\u4E3B\u5DF2\u89E3\u6563\u623F\u95F4");
      this.onChange?.(this);
      return;
    }
    this.listeners.delete(me.id);
    if (this.room.status === "playing") {
      me.online = false;
      me.autoPlay = true;
      if (me.kind === "human" && !this.chargedLeavers.has(me.id)) {
        this.chargedLeavers.add(me.id);
        const pay = this.leavePayInfo(me.id);
        try {
          this.onPlayerLeaveMidGame?.(me.id, me.name, pay.mult, pay.role);
        } catch {
        }
      }
    } else {
      this.room.players = this.room.players.filter((p) => p !== me);
      this.normalizeConfig();
    }
    this.changed();
  }
  /** 中途退出赔付信息：按当前剩余牌算倍数、按座位算角色 */
  leavePayInfo(playerId) {
    const g = this.game;
    if (!g) return { mult: 1 };
    const lefts = this.room.players.map((p) => g.hands?.[p.id]?.length ?? 0);
    const maxLeft = Math.max(0, ...lefts);
    const mult = maxLeft >= 15 ? 4 : maxLeft >= 10 ? 2 : 1;
    const seatIdx = g.seats.findIndex((x) => x.id === playerId);
    const role = g.mode !== "doudizhu" || g.landlordSeat == null ? void 0 : g.landlordSeat === seatIdx ? "landlord" : "farmer";
    return { mult, role };
  }
  uniqueName(name) {
    const names = new Set(this.room.players.map((p) => p.name));
    if (!names.has(name)) return name;
    for (let i = 2; ; i++) if (!names.has(`${name}${i}`)) return `${name}${i}`;
  }
  /** 真人不够时自动补位（优先真人，缺几个补几个） */
  autoFill() {
    if (this.room.status === "playing") return { filled: 0, humans: this.humans().length };
    const humans = this.humans().length;
    let filled = 0;
    const want = this.room.config.mode === "doudizhu" ? Math.min(4, Math.max(3, this.room.config.seatCount)) : 3;
    const target = Math.min(this.capacity(), want);
    const need = target - this.room.players.length;
    for (let i = 0; i < need; i++) {
      const delay = 2500 + i * 4500 + Math.random() * 3500;
      setTimeout(() => {
        if (this.room.status === "playing") return;
        if (this.room.players.length >= target) return;
        try {
          this.addSimulated();
        } catch {
        }
      }, delay);
      filled++;
    }
    if (filled) console.log("\u81EA\u52A8\u8865\u4F4D", this.room.code, `\u771F\u4EBA${humans} \u8BA1\u5212\u8865${filled}`);
    return { filled, humans };
  }
  /** 当前真人数量 */
  humanCount() {
    return this.humans().length;
  }
  addSimulated() {
    if (this.room.status === "playing") throw new GameError("\u6E38\u620F\u8FDB\u884C\u4E2D");
    if (this.humans().length >= this.capacity()) throw new GameError("\u623F\u95F4\u5DF2\u6EE1");
    const used = new Set(this.room.players.map((p) => p.name));
    const pool = rtCfg().names?.length ? rtCfg().names : SIM_NAMES;
    const avail = pool.filter((n) => !used.has(n));
    const name = avail.length ? avail[Math.floor(Math.random() * avail.length)] : this.uniqueName(pool[0] || "\u73A9\u5BB6");
    const now = Date.now();
    const id = randomId("sim");
    this.room.players.push({
      id,
      name,
      kind: "simulated",
      balance: this.virtualBalance(randomId("sim")),
      isHost: false,
      online: true,
      ready: false,
      autoPlay: false,
      // 模拟玩家在加入 0.6~2 秒后自动准备
      // 真实玩家进来后要看一眼，2~5 秒才点准备
      joinedAt: now + 2e3 + Math.random() * 3e3,
      lastSeen: now,
      latency: 20 + Math.round(Math.random() * 60)
    });
    this.normalizeConfig();
    this.changed();
    if (Math.random() < 0.55) {
      setTimeout(() => {
        try {
          const p = this.room.players.find((x) => x.id === id);
          if (!p) return;
          if (this.room.config.chat === "off") return;
          const phrase = QUICK_PHRASES[Math.floor(Math.random() * QUICK_PHRASES.length)];
          this.chat(p, "phrase", phrase, Date.now());
        } catch {
        }
      }, 3e3 + Math.random() * 9e3);
    }
  }
  /** 修正配置：座位数、推荐牌副数、最少手牌数 */
  normalizeConfig() {
    const c = this.room.config;
    const humans = this.humans().length;
    if (c.mode === "doudizhu") {
      c.seatCount = 3;
      c.deckCount = 1;
      c.withJokers = true;
      c.autoSeats = false;
      c.deckManual = true;
      c.turnSeconds = 15;
      return;
    }
    c.withJokers = false;
    c.turnSeconds = 15;
    if (c.autoSeats) c.seatCount = Math.max(MIN_PLAYERS, humans);
    c.seatCount = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, humans, Math.round(c.seatCount)));
    if (!c.deckManual) c.deckCount = recommendedDecks(c.seatCount);
    const perDeck = c.withJokers ? 54 : 52;
    const minDecks = Math.ceil(c.seatCount * MIN_CARDS_PER_PLAYER / perDeck);
    c.deckCount = Math.min(8, Math.max(minDecks, 1, Math.round(c.deckCount)));
    c.turnSeconds = Math.max(0, Math.min(120, Math.round(c.turnSeconds)));
  }
  startRound() {
    void this.refreshBalances();
    const need = this.room.config.seatCount - this.room.players.length;
    if (need > 0) {
      throw new GameError(`\u8FD8\u5DEE ${need} \u4EBA\uFF0C\u8BF7\u7B49\u5F85\u5339\u914D\u5B8C\u6210`);
    }
    const notReady = this.humans().filter((p) => !p.ready && !p.isHost);
    if (notReady.length) throw new GameError(`\u8FD8\u6709\u73A9\u5BB6\u672A\u51C6\u5907\uFF1A${notReady.map((p) => p.name).join("\u3001")}`);
    if (this.room.status === "finished") {
      this.room.players = this.room.players.filter((p) => p.kind === "ai" || p.online || p.isHost);
    }
    this.normalizeConfig();
    let seatsNeeded = 0;
    const usedNames = new Set(this.room.players.map((p) => p.name));
    const aiNames = AI_NAMES.filter((n) => !usedNames.has(n));
    for (let i = 0; i < seatsNeeded; i++) {
      const id = randomId("ai");
      const now = Date.now();
      this.room.players.push({
        id,
        name: aiNames[i] ?? `\u73A9\u5BB6${1e3 + i}`,
        kind: "ai",
        isHost: false,
        online: true,
        ready: true,
        autoPlay: false,
        joinedAt: now,
        lastSeen: now,
        latency: 0
      });
    }
    this.room.round += 1;
    this.deal();
    this.room.status = "playing";
    this.changed();
  }
  deal() {
    this.game = dealNewGame({
      mode: this.room.config.mode,
      seats: this.room.players.map((p) => ({ id: p.id, name: p.name, isAI: p.kind === "ai" })),
      deckCount: this.room.config.deckCount,
      withJokers: this.room.config.withJokers,
      round: this.room.round,
      previousWinnerId: this.room.lastWinnerId
    });
    this.game.turnStartedAt = Date.now() + DEAL_ANIMATION_MS;
    this.pendingAutoAt = null;
  }
  afterMove(prevPhase) {
    this.pendingAutoAt = null;
    const g = this.game;
    if (g.bidding?.allPassed) {
      this.deal();
      this.game.redealt = (g.redealt ?? 0) + 1;
    } else if (prevPhase === "bidding" && g.phase === "playing") {
      g.turnStartedAt = Date.now() + LANDLORD_REVEAL_MS;
    }
    if (g.phase === "finished" && g.settlement) {
      this.room.status = "finished";
      this.room.lastWinnerId = g.seats[g.winnerSeat].id;
      for (const r of g.settlement) {
        const st = this.playerWins.get(r.playerId) ?? { win: 0, total: 0 };
        st.total += 1;
        if (r.rank === 1) st.win += 1;
        this.playerWins.set(r.playerId, st);
        const pl = this.room.players.find((x) => x.id === r.playerId);
        if (pl && (pl.kind === "ai" || pl.kind === "simulated")) {
          const m = this.botMood.get(pl.id) ?? 0;
          this.botMood.set(pl.id, r.rank === 1 ? Math.max(0, m) + 1 : Math.min(0, m) - 1);
        }
      }
      this.onRoundFinished?.(buildRecord(this.room, g));
      void this.refreshBalances();
      this.botReaction(g);
    }
    this.changed();
  }
  // ---------------------------------------------------------------- 定时任务
  tick(now = Date.now()) {
    let dirty = false;
    for (const p of this.room.players) {
      if (p.kind === "human" && (!p.isHost || !this.hostIsServer) && p.online && now - p.lastSeen > OFFLINE_AFTER_MS) {
        p.online = false;
        dirty = true;
      }
      if (p.kind === "simulated" && !p.ready && now >= p.joinedAt) {
        p.ready = true;
        dirty = true;
      }
    }
    if (!this.hostIsServer && this.room.status !== "playing") dirty = this.handoverHost(now) || dirty;
    if (this.room.status === "playing" && this.game) {
      if (this.runAutomation(now)) return;
    }
    if (dirty) this.changed();
  }
  handoverHost(now) {
    const host = this.room.players.find((p) => p.isHost);
    if (!host || host.online || now - host.lastSeen < HOST_HANDOVER_MS) return false;
    const next = this.room.players.find((p) => p.kind === "human" && p.online && !p.isHost);
    if (!next) return false;
    host.isHost = false;
    next.isHost = true;
    next.ready = true;
    this.room.hostId = next.id;
    return true;
  }
  /** 机器人固定手速：用 id 哈希，同一个机器人始终同样快慢 */
  botSpeed(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = h * 31 + id.charCodeAt(i) | 0;
    const r = Math.abs(h % 100) / 100;
    return 500 + r * 4500;
  }
  /** 对局结束时机器人随口反应一句 */
  botReaction(g) {
    if (this.room.config.chat === "off") return;
    const win = new Set((g.winners ?? [g.winnerSeat ?? 0]).map((i) => g.seats[i].id));
    const bots = this.room.players.filter((p) => p.kind === "simulated" || p.kind === "ai");
    for (const b of bots) {
      if (Math.random() > 0.45) continue;
      const mood = this.botMood.get(b.id) ?? 0;
      const pool = win.has(b.id) ? mood >= 2 ? ["\u627F\u8BA9", "\u54C8\u54C8", "\u8FD0\u6C14\u597D", "666"] : ["\u627F\u8BA9", "\u54C8\u54C8", "666", "\u5389\u5BB3", "\u8C22\u8C22"] : mood <= -2 ? ["\u518D\u6765", "\u5931\u8BEF", "\u62B1\u6B49", "\u5509"] : ["\u518D\u6765", "\u5931\u8BEF", "\u7A0D\u7B49", "\u62B1\u6B49", "\u52A0\u6CB9"];
      const phrase = pool[Math.floor(Math.random() * pool.length)];
      setTimeout(() => {
        try {
          this.chat(b, "phrase", phrase, Date.now());
        } catch {
        }
      }, 800 + Math.random() * 2500);
    }
  }
  /** 是否已经没有任何真人在线（用于后端清理空房间） */
  isIdle() {
    return !this.room.players.some((p) => p.kind === "human" && p.online);
  }
  /** 需要由 AI 代替出牌的情况：AI、模拟玩家、托管、超时、掉线 */
  runAutomation(now) {
    const g = this.game;
    const seat = g.seats[g.turn];
    const player = this.room.players.find((p) => p.id === seat.id);
    if (!player || now < g.turnStartedAt) return false;
    let delay = null;
    if (player.kind === "ai" || player.kind === "simulated") {
      const base = this.botSpeed(player.id);
      delay = Math.max(400, base * (0.6 + Math.random() * 0.8) * this.hourFactor());
    } else if (player.autoPlay) delay = 600;
    else if (!player.online) delay = OFFLINE_TURN_GRACE_MS;
    else if (this.room.config.turnSeconds > 0 && now - g.turnStartedAt > this.room.config.turnSeconds * 1e3) {
      player.autoPlay = true;
      delay = 0;
    }
    if (delay === null) return false;
    if (this.pendingAutoAt === null) this.pendingAutoAt = now + delay;
    if (now < this.pendingAutoAt) return false;
    this.pendingAutoAt = null;
    const isBot = player.kind === "ai" || player.kind === "simulated";
    const level = isBot ? Math.random() < hardProb(g.mode) ? "hard" : "normal" : this.room.config.aiLevel;
    const prevPhase = g.phase;
    if (g.phase === "bidding") {
      this.game = placeBid(g, seat.id, decideBid(g.hands[seat.id], g.bidding.candidate !== null, level), now);
      this.afterMove(prevPhase);
      return true;
    }
    const next = nextSeat(g, g.turn);
    const opponents = g.seats.map((_, i) => i).filter((i) => !isTeammate(g, i, g.turn) && !isOut(g, i));
    const cards = decideMove({
      hand: g.hands[seat.id],
      target: g.lastPlay?.pattern ?? null,
      minOpponentCards: opponents.length ? Math.min(...opponents.map((i) => g.hands[g.seats[i].id].length)) : 99,
      nextPlayerCards: g.hands[g.seats[next].id].length,
      mode: g.mode,
      level,
      teammateOnTop: g.lastPlay !== null && g.lastPlay.seat !== g.turn && isTeammate(g, g.lastPlay.seat, g.turn),
      nextIsTeammate: isTeammate(g, next, g.turn),
      personality: isBot ? this.botPersona(seat.id) : void 0,
      played: g.log.flatMap((e) => e.cards ?? [])
    });
    this.noteAction(seat.id, !!cards, cards ? cards.length : 0);
    try {
      console.log(
        "AI\u51B3\u7B56",
        this.room.code,
        player.name,
        cards ? "\u51FA" + cards.length + "\u5F20" : "\u8FC7\u724C",
        "\u624B\u724C" + (g.hands[seat.id]?.length || 0),
        "\u76EE\u6807" + (g.lastPlay ? g.lastPlay.pattern?.type || "?" : "\u9886\u51FA")
      );
      this.game = cards ? playCards(g, seat.id, cards.map((c) => c.id), now) : passTurn(g, seat.id, now);
    } catch (e2) {
      console.log("AI\u5F02\u5E38", this.room.code, player.name, e2.message);
      this.game = g.lastPlay ? passTurn(g, seat.id, now) : playCards(g, seat.id, [g.hands[seat.id][0].id], now);
    }
    this.afterMove(prevPhase);
    return true;
  }
  // ---------------------------------------------------------------- 推送
  changed() {
    this.version++;
    for (const id of this.listeners.keys()) this.sendState(id);
    this.onChange?.(this);
  }
  sendState(playerId) {
    const listener = this.listeners.get(playerId);
    if (!listener) return;
    listener({
      type: "state",
      view: {
        room: this.room,
        game: this.game ? viewFor(this.game, playerId) : null,
        you: playerId,
        serverTime: Date.now(),
        version: this.version
      }
    });
  }
  /** 刷新房间内真人的棋牌钱包余额（fetcher 由 server 层注入，避免前端打包 node 模块） */
  async refreshBalances() {
    if (!balanceFetcher) return;
    for (const p of this.room.players) {
      if (p.kind !== "human") continue;
      if (!/^[A-Za-z0-9_]{2,40}$/.test(p.id)) continue;
      try {
        const v = await balanceFetcher(p.id);
        if (typeof v === "number" && !Number.isNaN(v)) p.balance = Math.round(v * 100) / 100;
      } catch {
      }
    }
    try {
      for (const [pid] of this.listeners) this.sendState(pid);
    } catch {
    }
  }
  summary() {
    const r = this.room;
    const g = this.game;
    const host = r.players.find((p) => p.isHost);
    return {
      code: r.code,
      hostName: host?.name ?? "-",
      mode: r.config.mode,
      status: r.status,
      round: r.round,
      seatCount: r.config.seatCount,
      deckCount: r.config.deckCount,
      withJokers: r.config.withJokers,
      createdAt: r.createdAt,
      updatedAt: Date.now(),
      players: r.players.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        isHost: p.isHost,
        online: p.online,
        ready: p.ready,
        autoPlay: p.autoPlay,
        latency: p.latency,
        cards: g ? g.hands[p.id]?.length ?? null : null,
        balance: p.balance
      })),
      turnPlayer: g && g.phase !== "finished" ? g.seats[g.turn].name : null,
      totalPlays: g ? g.log.filter((l) => l.action === "play").length : 0,
      chat: r.chat.slice(-15),
      moderation: this.moderation.slice(0, 20)
    };
  }
};

// server/auth.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
var PlayerTokens = class {
  constructor(secret) {
    this.secret = secret;
  }
  secret;
  sign(code, playerId) {
    return createHmac("sha256", this.secret).update(`${code}:${playerId}`).digest("base64url");
  }
  verify(code, playerId, token) {
    const expected = Buffer.from(this.sign(code, playerId));
    const got = Buffer.from(token);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }
};
var SESSION_MS = 2 * 3600 * 1e3;
var MAX_FAILS = 5;
var LOCK_MS = 60 * 1e3;
var AdminAuth = class {
  constructor(password) {
    this.password = password;
  }
  password;
  sessions = /* @__PURE__ */ new Map();
  fails = /* @__PURE__ */ new Map();
  /** 返回会话令牌；失败时抛出带提示的错误 */
  login(ip, password) {
    const now = Date.now();
    const f = this.fails.get(ip) ?? { count: 0, until: 0 };
    if (f.until > now) throw new AuthError(429, `\u5C1D\u8BD5\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7 ${Math.ceil((f.until - now) / 1e3)} \u79D2\u540E\u518D\u8BD5`);
    const a = Buffer.from(typeof password === "string" ? password : "");
    const b = Buffer.from(this.password);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      const count = f.count + 1;
      this.fails.set(ip, count >= MAX_FAILS ? { count: 0, until: now + LOCK_MS } : { count, until: 0 });
      throw new AuthError(401, count >= MAX_FAILS ? "\u5BC6\u7801\u9519\u8BEF\u6B21\u6570\u8FC7\u591A\uFF0C\u5DF2\u9501\u5B9A 60 \u79D2" : `\u5BC6\u7801\u9519\u8BEF\uFF08\u8FD8\u53EF\u5C1D\u8BD5 ${MAX_FAILS - count} \u6B21\uFF09`);
    }
    this.fails.delete(ip);
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, now + SESSION_MS);
    return token;
  }
  check(authHeader) {
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (!exp || exp < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }
  logout(authHeader) {
    if (authHeader?.startsWith("Bearer ")) this.sessions.delete(authHeader.slice(7));
  }
};
var AuthError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
var RateLimiter = class {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  limit;
  windowMs;
  hits = /* @__PURE__ */ new Map();
  allow(key) {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
  /** 定期清理过期条目 */
  sweep() {
    const now = Date.now();
    for (const [k, list] of this.hits) if (!list.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
};

// server/db.ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
var Store = class {
  db;
  constructor(file) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        room_code TEXT NOT NULL,
        mode TEXT NOT NULL,
        ended_at INTEGER NOT NULL,
        players TEXT NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_ended ON history (ended_at DESC);
      CREATE TABLE IF NOT EXISTS moderation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code TEXT NOT NULL,
        player_id TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        reason TEXT NOT NULL,
        at INTEGER NOT NULL
      );
    `);
  }
  getMeta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row?.value ?? null;
  }
  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  // ---------------------------------------------------------------- 房间快照
  saveRoom(snap) {
    this.db.prepare("INSERT INTO rooms (code, snapshot, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at").run(snap.room.code, JSON.stringify(snap), Date.now());
  }
  deleteRoom(code) {
    this.db.prepare("DELETE FROM rooms WHERE code = ?").run(code);
  }
  loadRooms(maxAgeMs) {
    this.db.prepare("DELETE FROM rooms WHERE updated_at < ?").run(Date.now() - maxAgeMs);
    const rows = this.db.prepare("SELECT snapshot FROM rooms").all();
    return rows.map((r) => JSON.parse(r.snapshot));
  }
  // ---------------------------------------------------------------- 历史记录
  addHistory(record) {
    this.db.prepare("INSERT OR REPLACE INTO history (id, room_code, mode, ended_at, players, record) VALUES (?, ?, ?, ?, ?, ?)").run(record.id, record.roomCode, record.mode, record.endedAt, record.players.map((p) => p.name).join(" "), JSON.stringify(record));
  }
  listHistory(limit = 500) {
    const rows = this.db.prepare("SELECT record FROM history ORDER BY ended_at DESC LIMIT ?").all(limit);
    return rows.map((r) => JSON.parse(r.record));
  }
  deleteHistory(id) {
    this.db.prepare("DELETE FROM history WHERE id = ?").run(id);
  }
  clearHistory() {
    this.db.exec("DELETE FROM history");
  }
  // ---------------------------------------------------------------- 审核记录
  addModeration(roomCode, entry) {
    this.db.prepare("INSERT INTO moderation (room_code, player_id, name, content, reason, at) VALUES (?, ?, ?, ?, ?, ?)").run(roomCode, entry.playerId, entry.name, entry.content, entry.reason, entry.at);
  }
  close() {
    this.db.close();
  }
};

// server/log.ts
function log(...args) {
  console.log((/* @__PURE__ */ new Date()).toISOString(), ...args);
}

// server/cardTables.js
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { randomInt as randomInt2, randomUUID } from "node:crypto";

// public/card-table/rules.js
var rank = (card) => card % 13 + 2;
var suit = (card) => Math.floor(card / 13);
var point = (card) => rank(card) === 14 ? 1 : Math.min(rank(card), 10);
function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}
function three(cards) {
  const r = cards.map(rank).sort((a, b) => b - a);
  const flush = cards.every((c) => suit(c) === suit(cards[0]));
  const run = r[0] - r[1] === 1 && r[1] - r[2] === 1 ? r[0] : r.join() === "14,3,2" ? 3 : 0;
  if (r[0] === r[2]) return [5, r[0]];
  if (flush && run) return [4, run];
  if (flush) return [3, ...r];
  if (run) return [2, run];
  if (r[0] === r[1]) return [1, r[0], r[2]];
  if (r[1] === r[2]) return [1, r[1], r[0]];
  return [0, ...r];
}
function bull(cards) {
  const total = cards.reduce((s, c) => s + point(c), 0);
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 4; j++) for (let k = j + 1; k < 5; k++) {
    if ((point(cards[i]) + point(cards[j]) + point(cards[k])) % 10 === 0)
      return { level: total % 10 || 10, trio: [i, j, k] };
  }
  return { level: 0, trio: [] };
}
function bullScore(cards) {
  const strength = (c) => (rank(c) === 14 ? 1 : rank(c)) * 4 + suit(c);
  return [bull(cards).level, Math.max(...cards.map(strength))];
}

// server/cardTables.js
function cardTables(path, config, clock = Date.now) {
  let db;
  function open() {
    if (db) return;
    const next = new DatabaseSync2(path, { open: false });
    next.open();
    try {
      next.exec("PRAGMA busy_timeout=3000");
      next.prepare("SELECT poker_balance FROM users LIMIT 0").all();
      next.exec("CREATE TABLE IF NOT EXISTS card_duels(id TEXT PRIMARY KEY, game TEXT, phase TEXT, due INTEGER, a TEXT, b TEXT, state TEXT); CREATE INDEX IF NOT EXISTS card_duels_due ON card_duels(phase,due); CREATE INDEX IF NOT EXISTS card_duels_a ON card_duels(a,phase); CREATE INDEX IF NOT EXISTS card_duels_b ON card_duels(b,phase)");
      db = next;
    } catch (e) {
      next.close();
      throw e;
    }
  }
  function money(uid, delta, r, memo) {
    if (uid === null || !delta) return;
    const row = db.prepare("UPDATE users SET poker_balance=round(poker_balance+?,2) WHERE uid=? AND poker_balance+?>=0 RETURNING poker_balance").get(delta, uid, delta);
    if (!row) throw new Error("\u68CB\u724C\u4F59\u989D\u4E0D\u8DB3");
    db.prepare("INSERT INTO flows(uid,kind,amount,balance,ref,memo,ctime) VALUES(?,?,?,?,?,?,?)").run(uid, delta > 0 ? "poker_win" : "poker_lose", delta, row.poker_balance, r.id, memo, Math.floor(clock() / 1e3));
  }
  function save(r) {
    db.prepare("INSERT OR REPLACE INTO card_duels VALUES(?,?,?,?,?,?,?)").run(r.id, r.game, r.phase, r.due, r.users[0], r.users[1], JSON.stringify(r));
  }
  function get(sql, ...args) {
    const row = db.prepare(sql).get(...args);
    return row && JSON.parse(row.state);
  }
  function begin(r) {
    r.phase = "play";
    r.paid = r.users.map(() => 1);
    r.active = r.users.map(() => true);
    const deck = Array.from({ length: 52 }, (_, i) => i);
    for (let i = 51; i > 0; i--) {
      const j = randomInt2(i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const n = r.game === "zjh" ? 3 : 5;
    r.hands = r.users.map((_, i) => deck.slice(i * n, (i + 1) * n));
    r.turn = randomInt2(r.users.length);
    r.levels = r.users.map(() => null);
    r.seen = r.users.map(() => false);
    r.base = 1;
    r.steps = 0;
    r.strength = Math.max(0, Math.min(1, (config(r.game).botRate - 0.5) / 0.25));
    deadline(r);
  }
  function deadline(r) {
    r.due = clock() + (r.users[r.turn] === null ? 1200 : 45e3);
  }
  function finish(r, winners) {
    const cents = r.paid.reduce((a, b) => a + b, 0) * 100;
    const payouts = r.paid.map((paid, i) => {
      if (!winners.length) return paid;
      const k = winners.indexOf(i);
      if (k < 0) return 0;
      return (Math.floor(cents / winners.length) + (k < cents % winners.length ? 1 : 0)) / 100;
    });
    r.delta = payouts.map((x, i) => Math.round((x - r.paid[i]) * 100) / 100);
    r.users.forEach((uid, i) => money(uid, payouts[i], r, "\u724C\u5C40\u7ED3\u7B97"));
    r.phase = "done";
    r.due = 0;
  }
  function contenders(r) {
    return r.users.map((_, i) => i).filter((i) => r.active?.[i] !== false);
  }
  function showdown(r) {
    const scores = r.hands.map((h, i) => r.game === "zjh" ? three(h) : [r.levels[i], bullScore(h)[1]]);
    const live = contenders(r);
    const best = live.reduce((a, b) => compare(scores[a], scores[b]) >= 0 ? a : b);
    finish(r, live.filter((i) => compare(scores[i], scores[best]) === 0));
  }
  function move(r, i, act, trio, target) {
    r.active ??= r.users.map(() => true);
    if (r.game === "nn") {
      let level = bull(r.hands[i]).level;
      if (act === "manual") {
        if (!Array.isArray(trio) || trio.length !== 3 || new Set(trio).size !== 3 || !trio.every((k) => Number.isInteger(k) && k >= 0 && k < 5) || trio.reduce((v, k) => v + point(r.hands[i][k]), 0) % 10) throw new Error("\u8BF7\u9009\u62E9\u4E09\u5F20\u80FD\u51D1\u6574\u5341\u7684\u724C");
      } else if (act === "none") {
        level = 0;
      } else if (act !== "auto") throw new Error("\u64CD\u4F5C\u65E0\u6548");
      r.levels[i] = level;
      if (r.levels.every((v) => v !== null)) {
        showdown(r);
        return;
      }
    } else {
      if (act === "look" && !r.seen[i]) {
        r.seen[i] = true;
        return;
      }
      if (act === "fold") {
        r.active[i] = false;
      } else {
        if (!["raise", "call", "compare"].includes(act) || act === "raise" && r.base >= 5) throw new Error("\u64CD\u4F5C\u65E0\u6548");
        if (act === "raise") r.base++;
        const cost = r.base * (r.seen[i] ? 2 : 1);
        money(r.users[i], -cost, r, "\u724C\u5C40\u6295\u5165");
        r.paid[i] += cost;
        if (act === "compare") {
          const opponents = contenders(r).filter((k2) => k2 !== i);
          const k = target ?? opponents[0];
          if (!opponents.includes(k)) throw new Error("\u8BF7\u9009\u62E9\u4ECD\u5728\u5C40\u5185\u7684\u5BF9\u624B");
          if (r.users.length === 2) {
            showdown(r);
            return;
          }
          r.active[compare(three(r.hands[i]), three(r.hands[k])) > 0 ? k : i] = false;
        }
        if (++r.steps >= 8 * r.users.length) {
          showdown(r);
          return;
        }
      }
      const live = contenders(r);
      if (live.length === 1) {
        finish(r, live);
        return;
      }
    }
    do {
      r.turn = (r.turn + 1) % r.users.length;
    } while (!r.active[r.turn]);
    deadline(r);
  }
  function advance(r) {
    if (r.phase === "wait") {
      begin(r);
      return;
    }
    const i = r.turn;
    if (r.users[i] !== null) {
      move(r, i, r.game === "nn" ? "auto" : "fold");
      return;
    }
    const smart = randomInt2(1e4) < r.strength * 1e4;
    if (r.game === "nn") {
      move(r, i, smart || randomInt2(5) !== 0 ? "auto" : "none");
      return;
    }
    r.seen[i] = true;
    const score = three(r.hands[i]);
    const weak = score[0] === 0 && score[1] < 12;
    const act = smart && weak && r.steps >= 2 ? "fold" : smart && score[0] > 0 && r.base < 5 && r.steps < 6 ? "raise" : r.steps >= 4 ? "compare" : "call";
    move(r, i, act);
  }
  function tx(fn) {
    open();
    db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  function tick() {
    if (!db) return;
    tx(() => {
      for (const row of db.prepare("SELECT state FROM card_duels WHERE phase IN ('wait','play') AND due<=? LIMIT 100").all(clock())) {
        const r = JSON.parse(row.state);
        advance(r);
        r.rev++;
        save(r);
      }
    });
  }
  function request(uid, body) {
    return tx(() => {
      let r;
      if (body.action === "join") {
        if (!["zjh", "nn"].includes(body.game)) throw new Error("\u6E38\u620F\u65E0\u6548");
        r = get("SELECT state FROM card_duels WHERE phase IN ('wait','play') AND EXISTS(SELECT 1 FROM json_each(state,'$.users') WHERE value=?) LIMIT 1", uid);
        if (!r) {
          const user = db.prepare("SELECT poker_balance,status FROM users WHERE uid=?").get(uid);
          if (!user || user.status !== 1 || user.poker_balance < Math.max(1, config().minBal)) throw new Error("\u8D26\u6237\u4E0D\u53EF\u5165\u573A\u6216\u68CB\u724C\u4F59\u989D\u4E0D\u8DB3");
          r = get("SELECT state FROM card_duels WHERE game=? AND phase='wait' AND json_array_length(state,'$.users')=5 AND due>? ORDER BY due LIMIT 1", body.game, clock());
          if (!r) r = { id: randomUUID(), users: Array(5).fill(null), game: body.game, phase: "wait", due: clock() + 8e3, rev: 0, paid: Array(5).fill(0) };
          const seat = r.users.indexOf(null);
          r.users[seat] = uid;
          r.paid[seat] = 1;
          r.rev++;
          money(uid, -1, r, "\u5339\u914D\u5E95\u6CE8");
          if (!r.users.includes(null)) begin(r);
          save(r);
        }
      } else {
        r = get("SELECT state FROM card_duels WHERE id=?", String(body.id || ""));
        if (!r || !r.users.includes(uid)) throw new Error("\u724C\u5C40\u4E0D\u5B58\u5728");
        if (body.action !== "state" && body.rev === r.rev && r.phase !== "done") {
          if (clock() >= r.due) {
            advance(r);
          } else if (r.phase === "wait" && body.action === "cancel") {
            const seat = r.users.indexOf(uid);
            money(uid, r.paid[seat], r, "\u53D6\u6D88\u5339\u914D\u9000\u6B3E");
            r.users[seat] = null;
            r.paid[seat] = 0;
            if (r.users.every((u) => u === null)) {
              r.phase = "done";
              r.due = 0;
            }
            r.rev++;
            save(r);
            return { id: r.id, game: r.game, phase: "cancelled" };
          } else if (r.phase === "play" && r.users[r.turn] === uid) {
            move(r, r.turn, body.action, body.trio, body.target);
          } else throw new Error("\u8BF7\u7B49\u5F85\u5BF9\u624B");
          r.rev++;
          save(r);
        }
      }
      const me = r.users.indexOf(uid), reveal = r.phase === "done" && Boolean(r.hands);
      return {
        id: r.id,
        rev: r.rev,
        game: r.game,
        phase: r.phase,
        due: r.due,
        me,
        seats: r.users.map((u, i) => ({
          seat: i,
          kind: u ? "\u771F\u4EBA" : r.phase === "wait" ? "\u7A7A\u4F4D" : "\u673A\u5668\u4EBA",
          active: r.active?.[i] !== false,
          acting: r.phase === "play" && r.turn === i,
          paid: r.paid[i],
          delta: r.delta?.[i],
          hand: reveal ? r.hands[i] : [],
          ready: r.levels?.[i] != null
        })),
        turn: r.turn === me,
        base: r.base,
        seen: r.seen?.[me],
        pot: r.paid.reduce((a, b) => a + b, 0),
        delta: r.delta?.[me],
        level: r.levels?.[me],
        wallet: db.prepare("SELECT poker_balance FROM users WHERE uid=?").get(uid)?.poker_balance,
        hand: r.hands && (reveal || r.game === "nn" || r.seen[me]) ? r.hands[me] : []
      };
    });
  }
  return { request, tick, resume() {
    open();
    tick();
  }, close() {
    db?.close();
    db = null;
  } };
}

// server/app.ts
init_rtcfg();

// server/rooms.ts
init_settle();
init_rtcfg();
init_results();
var IDLE_ROOM_MS = 30 * 60 * 1e3;
var RESTORE_MAX_AGE_MS = 6 * 3600 * 1e3;
var PERSIST_DEBOUNCE_MS = 1e3;
var RoomManager = class {
  constructor(store, maxRooms) {
    this.store = store;
    this.maxRooms = maxRooms;
    this.restore();
    this.sweepTimer = setInterval(() => this.sweep(), 60 * 1e3);
  }
  store;
  maxRooms;
  rooms = /* @__PURE__ */ new Map();
  idleSince = /* @__PURE__ */ new Map();
  persistTimers = /* @__PURE__ */ new Map();
  sweepTimer;
  get size() {
    return this.rooms.size;
  }
  get(code) {
    return this.rooms.get(code);
  }
  create(hostName, config, hostUid, ip, fp) {
    if (this.rooms.size >= this.maxRooms) throw new Error("\u670D\u52A1\u5668\u623F\u95F4\u5DF2\u6EE1\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
    if (rtCfg().sameDev && (ip || fp)) {
      for (const srv of this.rooms.values()) {
        if (srv.isIdle()) continue;
        const dup = srv.room.players.find((p) => p.kind === "human" && p.online && (p.ip === ip || fp && p.fp === fp));
        if (dup) throw new Error("\u68C0\u6D4B\u5230\u540C\u4E00\u8BBE\u5907\u5DF2\u6709\u73A9\u5BB6\u5728\u7EBF\uFF0C\u8BF7\u52FF\u591A\u5F00");
      }
    }
    const code = generateInviteCode((c) => this.rooms.has(c));
    const hostId = hostUid && /^[A-Za-z0-9_]{3,24}$/.test(hostUid) ? hostUid : randomId("host");
    const server = RoomServer.create(code, hostId, hostName, config, ip, fp);
    this.wire(server);
    this.persist(server);
    log("\u623F\u95F4\u521B\u5EFA", code, hostName);
    this.scheduleAutoFill(code);
    return { code, hostId };
  }
  autoFillTimers = /* @__PURE__ */ new Map();
  /** 20 秒后检查人数，不够就补 AI；真人满员则跳过 */
  scheduleAutoFill(code) {
    const old = this.autoFillTimers.get(code);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.autoFillTimers.delete(code);
      const server = this.rooms.get(code);
      if (!server) return;
      try {
        const r = server.autoFill();
        if (r.filled) log("\u8865\u4F4D\u5B8C\u6210", code, `\u771F\u4EBA${r.humans} \u8865${r.filled}`);
      } catch (e) {
        log("\u8865\u4F4D\u5931\u8D25", code, e.message);
      }
    }, 8e3);
    this.autoFillTimers.set(code, t);
  }
  /** 有真人加入/离开时重新计时 */
  rescheduleAutoFill(code) {
    const server = this.rooms.get(code);
    if (!server || server.room.status === "playing") return;
    if (server.humanCount() >= server.room.config.seatCount) {
      const t = this.autoFillTimers.get(code);
      if (t) {
        clearTimeout(t);
        this.autoFillTimers.delete(code);
      }
      return;
    }
    this.scheduleAutoFill(code);
  }
  summaries() {
    return [...this.rooms.values()].filter((r) => !r.closed).map((r) => r.summary());
  }
  close(code, reason = "\u623F\u95F4\u5DF2\u88AB\u7BA1\u7406\u5458\u5173\u95ED") {
    const server = this.rooms.get(code);
    if (!server) return false;
    server.destroy(reason);
    this.drop(code);
    return true;
  }
  wire(server) {
    const code = server.room.code;
    server.hostIsServer = false;
    server.onChange = (s) => {
      if (s.closed) return this.drop(code);
      this.schedulePersist(s);
    };
    const verified = (uid) => this.store.getMeta("wallet:" + code + ":" + server.room.createdAt + ":" + uid) === "1";
    server.onRoundFinished = (record) => {
      const rows = record.settlement.map((r) => ({ uid: r.playerId, name: r.name, rank: r.rank, remaining: r.remaining, role: r.role }));
      const { deltas } = calcDeltas(rows, 1, 0, record.mode, record.bombs || 0);
      const payable = deltas.filter((d) => verified(d.uid) && record.players.some((p) => p.id === d.uid && p.kind === "human"));
      record.walletStatus = "none";
      if (payable.length) {
        try {
          const receipt = bookRound(record.id, payable);
          record.walletStatus = "booked";
          record.walletMoves = receipt.moves;
          for (const move of receipt.moves) {
            try {
              if (receipt.fresh && move.delta !== 0) bumpStreak(move.uid, move.delta > 0);
              putResult(move.uid, { delta: move.delta, balance: move.balance, room: code, at: Date.now() });
            } catch (e) {
              log("\u94B1\u5305\u5DF2\u5165\u8D26\uFF0C\u6218\u7EE9\u66F4\u65B0\u5931\u8D25", record.id, String(e));
            }
          }
        } catch (e) {
          record.walletStatus = "pending";
          record.walletMoves = payable;
          record.walletReason = e instanceof Error ? e.message : "\u94B1\u5305\u5165\u8D26\u5931\u8D25";
          log("\u6574\u5C40\u94B1\u5305\u5F85\u6838\u5BF9", record.id, String(e));
        }
      }
      if (record.walletStatus === "pending") {
        server.system("\u672C\u5C40\u94B1\u5305\u672A\u5165\u8D26\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u6838\u5BF9\u3002");
      } else {
        server.applyDeltas(deltas);
        for (const row of record.settlement) Object.assign(row, { delta: deltas.find((d) => d.uid === row.playerId)?.delta ?? 0 });
      }
      this.store.addHistory(record);
      server.broadcastAll();
    };
    server.onPlayerLeaveMidGame = (uid, name, mult, role) => {
      if (!verified(uid)) return;
      if (!/^[A-Za-z0-9_]{3,24}$/.test(uid) || /^(host|p|sim)_/.test(uid)) return;
      void (async () => {
        try {
          const base = 1;
          const pot = base * (mult || 1);
          const amount = role === "landlord" ? pot * 2 : pot;
          const r = await chargeFee(uid, amount);
          log("\u4E2D\u9014\u9000\u51FA\u8D54\u4ED8", code, name, `\u500D\u6570${mult} \u89D2\u8272${role || "-"} \u6263${amount}\u5143 \u4F59\u989D${r.balance}`);
        } catch (e) {
          log("\u6263\u8D39\u5931\u8D25", code, name, e.message);
        }
      })();
    };
    server.onModeration = (entry) => {
      log("\u62E6\u622A\u804A\u5929", code, entry.name, entry.reason);
      this.store.addModeration(code, entry);
    };
    this.rooms.set(code, server);
    server.start();
  }
  schedulePersist(server) {
    const code = server.room.code;
    if (this.persistTimers.has(code)) return;
    this.persistTimers.set(
      code,
      setTimeout(() => {
        this.persistTimers.delete(code);
        if (!server.closed) this.persist(server);
      }, PERSIST_DEBOUNCE_MS)
    );
  }
  persist(server) {
    try {
      this.store.saveRoom(server.snapshot());
    } catch (e) {
      log("\u4FDD\u5B58\u623F\u95F4\u5931\u8D25", server.room.code, e);
    }
  }
  drop(code) {
    const t = this.persistTimers.get(code);
    if (t) clearTimeout(t);
    this.persistTimers.delete(code);
    this.rooms.get(code)?.stop();
    this.rooms.delete(code);
    this.idleSince.delete(code);
    this.store.deleteRoom(code);
    log("\u623F\u95F4\u5173\u95ED", code);
  }
  /** 服务器重启后恢复房间：所有真人先标记为离线，等待重连 */
  restore() {
    const now = Date.now();
    for (const snap of this.store.loadRooms(RESTORE_MAX_AGE_MS)) {
      for (const p of snap.room.players) {
        if (p.kind === "human") {
          p.online = false;
          p.lastSeen = now;
        }
      }
      if (snap.game && snap.game.phase !== "finished") snap.game.turnStartedAt = Math.max(snap.game.turnStartedAt, now + 5e3);
      this.wire(new RoomServer(snap));
    }
    if (this.rooms.size) log(`\u5DF2\u6062\u590D ${this.rooms.size} \u4E2A\u623F\u95F4`);
  }
  sweep() {
    const now = Date.now();
    for (const [code, server] of this.rooms) {
      if (!server.isIdle()) {
        this.idleSince.delete(code);
        continue;
      }
      const since = this.idleSince.get(code) ?? now;
      this.idleSince.set(code, since);
      if (now - since > IDLE_ROOM_MS) this.close(code, "\u623F\u95F4\u957F\u65F6\u95F4\u65E0\u4EBA\uFF0C\u5DF2\u81EA\u52A8\u5173\u95ED");
    }
  }
  /** 关闭服务器前把所有房间写入数据库 */
  shutdown() {
    clearInterval(this.sweepTimer);
    for (const t of this.persistTimers.values()) clearTimeout(t);
    this.persistTimers.clear();
    for (const server of this.rooms.values()) {
      server.stop();
      if (!server.closed) this.persist(server);
    }
  }
};

// server/validate.ts
var isStr = (v, max) => typeof v === "string" && v.length <= max;
var isBool = (v) => typeof v === "boolean";
var isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
function sanitizeConfig(raw) {
  if (!raw || typeof raw !== "object") return {};
  const r = raw;
  const out = {};
  if (r.mode === "paodekuai" || r.mode === "doudizhu") out.mode = r.mode;
  if (r.aiLevel === "easy" || r.aiLevel === "normal" || r.aiLevel === "hard") out.aiLevel = r.aiLevel;
  if (isInt(r.seatCount, 3, 8)) out.seatCount = r.seatCount;
  if (isBool(r.autoSeats)) out.autoSeats = r.autoSeats;
  if (isInt(r.deckCount, 1, 8)) out.deckCount = r.deckCount;
  if (isBool(r.deckManual)) out.deckManual = r.deckManual;
  if (isBool(r.withJokers)) out.withJokers = r.withJokers;
  if (isInt(r.turnSeconds, 0, 120)) out.turnSeconds = r.turnSeconds;
  if (r.chat === "full" || r.chat === "preset" || r.chat === "off") out.chat = r.chat;
  return out;
}
var CHAT_KINDS = ["phrase", "emoji", "text"];
function parseClientMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const m = raw;
  switch (m.type) {
    case "join":
      return isStr(m.name, 40) ? { type: "join", name: m.name } : null;
    case "leave":
    case "addSimulated":
    case "start":
    case "pass":
    case "nextRound":
    case "backToLobby":
      return { type: m.type };
    case "heartbeat":
      return { type: "heartbeat", sentAt: typeof m.sentAt === "number" && Number.isFinite(m.sentAt) ? m.sentAt : Date.now() };
    case "ready":
      return isBool(m.ready) ? { type: "ready", ready: m.ready } : null;
    case "autoPlay":
      return isBool(m.on) ? { type: "autoPlay", on: m.on } : null;
    case "bid":
      return isBool(m.call) ? { type: "bid", call: m.call } : null;
    case "config": {
      const patch = sanitizeConfig(m.patch);
      return Object.keys(patch).length ? { type: "config", patch } : null;
    }
    case "kick":
      return isStr(m.targetId, 64) ? { type: "kick", targetId: m.targetId } : null;
    case "play":
      return Array.isArray(m.cardIds) && m.cardIds.length > 0 && m.cardIds.length <= 60 && m.cardIds.every((id) => isStr(id, 32)) ? { type: "play", cardIds: m.cardIds } : null;
    case "chat":
      return CHAT_KINDS.includes(m.kind) && isStr(m.content, 40) ? { type: "chat", kind: m.kind, content: m.content } : null;
    default:
      return null;
  }
}
function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f​-‏⁠﻿]/g, "").replace(/[<>]/g, "").trim().slice(0, 12);
  return name || null;
}

// server/app.ts
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
var MAX_BODY = 16 * 1024;
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json"
};
async function createApp(opts) {
  const store = new Store(opts.dbFile);
  void Promise.resolve().then(() => (init_results(), results_exports)).then((m) => m.bindStore(store));
  const secret = opts.sessionSecret || store.getMeta("session_secret") || randomBytes2(32).toString("hex");
  if (!opts.sessionSecret) store.setMeta("session_secret", secret);
  let adminPassword = opts.adminPassword || store.getMeta("admin_password") || "";
  if (!adminPassword) {
    adminPassword = randomBytes2(9).toString("base64url");
    store.setMeta("admin_password", adminPassword);
    if (!opts.quiet) log(`\u5DF2\u751F\u6210\u540E\u53F0\u5BC6\u7801\uFF1A${adminPassword}\uFF08\u4EC5\u663E\u793A\u8FD9\u4E00\u6B21\uFF0C\u53EF\u901A\u8FC7\u73AF\u5883\u53D8\u91CF ADMIN_PASSWORD \u8986\u76D6\uFF09`);
  }
  const tokens = new PlayerTokens(secret);
  const admin = new AdminAuth(adminPassword);
  const rooms = new RoomManager(store, opts.maxRooms ?? 500);
  const walletPath = process.env.CARD_WALLET_DB || "/opt/ssc-ops/ssc_ops.db";
  const readTargets = () => JSON.parse(store.getMeta("bot_targets") || "{}");
  useTargets(readTargets());
  const duels = cardTables(walletPath, (game) => ({ ...rtCfg(), botRate: gameRate(game) }));
  if (existsSync2(walletPath)) {
    try {
      duels.resume();
    } catch (e) {
      log("\u53CC\u4EBA\u724C\u684C\u94B1\u5305\u672A\u5C31\u7EEA", String(e));
    }
  }
  const duelTimer = setInterval(() => {
    try {
      duels.tick();
    } catch (e) {
      log("\u53CC\u4EBA\u724C\u684C\u7EF4\u62A4\u5931\u8D25", String(e));
    }
  }, 1e3);
  const createLimiter = new RateLimiter(10, 60 * 1e3);
  const joinLimiter = new RateLimiter(30, 60 * 1e3);
  const sweep = setInterval(() => {
    createLimiter.sweep();
    joinLimiter.sweep();
  }, 60 * 1e3);
  const staticDir = opts.staticDir && existsSync2(join(opts.staticDir, "index.html")) ? resolve(opts.staticDir) : null;
  if (!opts.quiet) log(staticDir ? `\u6258\u7BA1\u524D\u7AEF\uFF1A${staticDir}` : "\u672A\u627E\u5230\u524D\u7AEF\u6784\u5EFA\u4EA7\u7269\uFF0C\u4EC5\u63D0\u4F9B API");
  const ipOf = (req) => {
    const fwd = opts.trustProxy ? req.headers["x-forwarded-for"]?.split(",")[0]?.trim() : void 0;
    return fwd || req.socket.remoteAddress || "unknown";
  };
  const send = (res, status, body) => {
    if (body === void 0) {
      res.writeHead(status).end();
      return;
    }
    const data = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(data);
  };
  const readJson = (req) => new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new HttpError(413, "\u8BF7\u6C42\u4F53\u8FC7\u5927"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return ok({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        ok(v && typeof v === "object" ? v : {});
      } catch {
        fail(new HttpError(400, "\u8BF7\u6C42\u683C\u5F0F\u9519\u8BEF"));
      }
    });
    req.on("error", fail);
  });
  const requireAdmin = (req) => {
    if (!admin.check(req.headers.authorization)) throw new HttpError(401, "\u672A\u767B\u5F55\u6216\u767B\u5F55\u5DF2\u8FC7\u671F");
  };
  function walletIdentity(req, expected) {
    const auth = String(req.headers.authorization || "");
    if (!expected && !auth) return "";
    const [uid, expiry, signature] = auth.replace(/^Bearer /, "").split(".");
    if (!uid || !/^\d+$/.test(expiry || "") || Number(expiry) <= Date.now() || !signature || !tokens.verify("duel-" + expiry, uid, signature) || expected && expected !== uid)
      throw new HttpError(401, "\u8BF7\u4ECE\u4E3B\u7AD9\u91CD\u65B0\u8FDB\u5165\u68CB\u724C\u5927\u5385");
    return uid;
  }
  async function api(req, res, path) {
    const method = req.method ?? "GET";
    const ip = ipOf(req);
    let m;
    if (method === "POST" && path === "/card-table") {
      const b = await readJson(req);
      const uid = walletIdentity(req);
      if (!uid) throw new HttpError(401, "\u8BF7\u5148\u767B\u5F55");
      if (!existsSync2(walletPath)) throw new HttpError(503, "\u68CB\u724C\u94B1\u5305\u6570\u636E\u5E93\u672A\u63A5\u5165");
      try {
        return send(res, 200, duels.request(uid, b));
      } catch (e) {
        const msg = e.message;
        if (/sqlite|database|SQLITE|table:|readonly/i.test(msg)) {
          log("\u68CB\u724C\u94B1\u5305\u5F02\u5E38", msg);
          throw new HttpError(503, "\u68CB\u724C\u94B1\u5305\u6682\u4E0D\u53EF\u7528");
        }
        throw new HttpError(400, msg);
      }
    }
    if (method === "GET" && path === "/lastresult") {
      const u = new URL(req.url || "/", "http://x").searchParams.get("uid") || "";
      if (!u) throw new HttpError(400, "\u53C2\u6570\u7F3A\u5931");
      const { getResult: getResult2, getStreak: getStreak2 } = await Promise.resolve().then(() => (init_results(), results_exports));
      const r = getResult2(u) ?? {};
      return send(res, 200, { ...r, streak: getStreak2(u) });
    }
    if (method === "GET" && path === "/me/balance") {
      const uid = String(new URL(req.url || "/", "http://x").searchParams.get("uid") || "").trim();
      if (!/^[A-Za-z0-9_]{2,40}$/.test(uid)) {
        send(res, 400, { error: "uid \u975E\u6CD5" });
        return;
      }
      try {
        const { getBalance: getBalance2 } = await Promise.resolve().then(() => (init_settle(), settle_exports));
        const r = await getBalance2(uid);
        send(res, 200, { balance: Number((r && r.balance) ?? 0) });
      } catch (e) {
        send(res, 200, { balance: null, error: e.message });
      }
      return;
    }
    if (method === "POST" && path === "/sso") {
      const body = await readJson(req);
      const uid = String(body.uid || "").slice(0, 32);
      const ts = Number(body.ts || 0);
      const sig2 = String(body.sig || "");
      if (!uid || !ts || !sig2) throw new HttpError(400, "\u53C2\u6570\u7F3A\u5931");
      if (Math.abs(Math.floor(Date.now() / 1e3) - ts) > 300) throw new HttpError(401, "\u4EE4\u724C\u5DF2\u8FC7\u671F");
      const secret2 = process.env.POKER_SSO_SECRET || "";
      if (!secret2) throw new HttpError(503, "\u5355\u70B9\u767B\u5F55\u672A\u914D\u7F6E");
      const want = createHmac3("sha256", secret2).update(`${uid}:${ts}:0:`).digest("hex").slice(0, 32);
      if (want !== sig2) throw new HttpError(401, "\u7B7E\u540D\u6821\u9A8C\u5931\u8D25");
      try {
        const { getBalance: getBalance2 } = await Promise.resolve().then(() => (init_settle(), settle_exports));
        const b = await getBalance2(uid);
        const bal = Number(b && b.balance || 0);
        const { rtCfg: rtCfg2 } = await Promise.resolve().then(() => (init_rtcfg(), rtcfg_exports));
        const minBal = rtCfg2().minBal;
        if (bal < minBal) throw new HttpError(403, `\u4F59\u989D\u4E0D\u8DB3 ${minBal} \u5143\uFF0C\u8BF7\u5148\u5145\u503C`);
        log("\u5355\u70B9\u767B\u5F55", uid, `\u4F59\u989D${bal}`);
        const expiry = Date.now() + 12 * 36e5;
        const cardToken = uid + "." + expiry + "." + tokens.sign("duel-" + expiry, uid);
        return send(res, 200, { uid, name: uid, balance: bal, cardToken });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        log("\u4F59\u989D\u67E5\u8BE2\u5931\u8D25", uid, e.message);
        throw new HttpError(503, "\u68CB\u724C\u94B1\u5305\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      }
    }
    if (method === "GET" && path === "/health") return send(res, 200, { ok: true, rooms: rooms.size });
    if (method === "POST" && path === "/rooms") {
      if (!createLimiter.allow(ip)) throw new HttpError(429, "\u521B\u5EFA\u623F\u95F4\u592A\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
      const body = await readJson(req);
      const name = cleanName(body.hostName);
      if (!name) throw new HttpError(400, "\u8BF7\u8F93\u5165\u6635\u79F0");
      const wantUid0 = walletIdentity(req, body.uid);
      if (!wantUid0 && containsBlocked(name)) throw new HttpError(400, "\u6635\u79F0\u5305\u542B\u4E0D\u6587\u660E\u5185\u5BB9\uFF0C\u8BF7\u4FEE\u6539");
      const wantUid = wantUid0;
      let code;
      let hostId;
      try {
        ({ code, hostId } = rooms.create(wantUid ? wantUid : name, sanitizeConfig(body.config), wantUid, ip, typeof body.fp === "string" ? body.fp.slice(0, 24) : ""));
      } catch (e) {
        const msg = e.message;
        if (msg.includes("\u540C\u4E00\u8BBE\u5907") || msg.includes("\u623F\u95F4\u5DF2\u6EE1")) throw new HttpError(400, msg);
        throw e;
      }
      if (wantUid) store.setMeta("wallet:" + code + ":" + rooms.get(code).room.createdAt + ":" + hostId, "1");
      return send(res, 200, { code, playerId: hostId, token: tokens.sign("room-v2:" + code, hostId) });
    }
    if (method === "POST" && (m = path.match(/^\/rooms\/([A-Za-z0-9]{6})\/join$/))) {
      if (!joinLimiter.allow(ip)) throw new HttpError(429, "\u8BF7\u6C42\u592A\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
      const code = normalizeCode(m[1]);
      const room = rooms.get(code);
      if (!room || room.closed) throw new HttpError(404, "\u623F\u95F4\u4E0D\u5B58\u5728\uFF0C\u8BF7\u68C0\u67E5\u9080\u8BF7\u7801");
      const body = await readJson(req);
      const name = cleanName(body.name);
      if (!name) throw new HttpError(400, "\u8BF7\u8F93\u5165\u6635\u79F0");
      const wantUidJ = walletIdentity(req, body.uid);
      if (!wantUidJ && containsBlocked(name)) throw new HttpError(400, "\u6635\u79F0\u5305\u542B\u4E0D\u6587\u660E\u5185\u5BB9\uFF0C\u8BF7\u4FEE\u6539");
      if (room.room.status !== "waiting") throw new HttpError(409, "\u6E38\u620F\u8FDB\u884C\u4E2D\uFF0C\u6682\u65F6\u65E0\u6CD5\u52A0\u5165");
      const playerId = wantUidJ || randomId("p");
      if (wantUidJ) store.setMeta("wallet:" + code + ":" + room.room.createdAt + ":" + playerId, "1");
      return send(res, 200, { playerId, token: tokens.sign("room-v2:" + code, playerId) });
    }
    if (method === "POST" && path === "/admin/login") {
      const body = await readJson(req);
      try {
        return send(res, 200, { token: admin.login(ip, body.password) });
      } catch (e) {
        if (e instanceof AuthError) {
          log("\u540E\u53F0\u767B\u5F55\u5931\u8D25", ip);
          throw new HttpError(e.status, e.message);
        }
        throw e;
      }
    }
    if (method === "POST" && path === "/admin/logout") {
      admin.logout(req.headers.authorization);
      return send(res, 204);
    }
    if (path.startsWith("/admin/")) {
      requireAdmin(req);
      if (path === "/admin/bot-targets") {
        if (method === "GET") return send(res, 200, { targets: readTargets(), fallback: Math.round(rtCfg().botRate * 100) });
        if (method === "POST") {
          const input = await readJson(req);
          if (botGames.some((g) => !(g in input)) || Object.keys(input).length !== botGames.length)
            throw new HttpError(400, "\u8BF7\u63D0\u4EA4\u5B8C\u6574\u7684\u56DB\u6B3E\u68CB\u724C\u53C2\u6570");
          const next = {};
          for (const game of botGames) {
            const value = input[game];
            if (value === null) continue;
            if (typeof value !== "number" || !Number.isInteger(value) || value < 50 || value > 75)
              throw new HttpError(400, "\u76EE\u6807\u503C\u987B\u4E3A 50 \u81F3 75 \u7684\u6574\u6570");
            next[game] = value;
          }
          store.setMeta("bot_targets", JSON.stringify(next));
          useTargets(next);
          return send(res, 204);
        }
      }
      if (method === "GET" && path === "/admin/rooms") return send(res, 200, rooms.summaries());
      if (method === "DELETE" && (m = path.match(/^\/admin\/rooms\/([A-Z0-9]{6})$/))) {
        rooms.close(m[1]);
        return send(res, 204);
      }
      if (method === "GET" && path === "/admin/history") return send(res, 200, store.listHistory(500));
      if (method === "DELETE" && path === "/admin/history") {
        store.clearHistory();
        log("\u540E\u53F0\u6E05\u7A7A\u5386\u53F2\u8BB0\u5F55", ip);
        return send(res, 204);
      }
      if (method === "DELETE" && (m = path.match(/^\/admin\/history\/(.+)$/))) {
        store.deleteHistory(decodeURIComponent(m[1]));
        return send(res, 204);
      }
    }
    throw new HttpError(404, "\u63A5\u53E3\u4E0D\u5B58\u5728");
  }
  function serveStatic(req, res, urlPath) {
    if (urlPath === "/admin" || urlPath.startsWith("/admin/")) {
      return send(res, 404, { error: "Not found" });
    }
    if (!staticDir || req.method !== "GET" && req.method !== "HEAD") return send(res, 404, { error: "Not found" });
    let file = resolve(staticDir, "." + normalize2(decodeURIComponent(urlPath)));
    if (!file.startsWith(staticDir + sep) && file !== staticDir) return send(res, 403, { error: "Forbidden" });
    let isIndex = false;
    if (!existsSync2(file) || statSync(file).isDirectory()) {
      if (extname(urlPath)) return send(res, 404, { error: "Not found" });
      file = join(staticDir, "index.html");
      isIndex = true;
    }
    const ext = extname(file);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": isIndex || ext === ".html" ? "no-cache" : urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600"
    });
    if (req.method === "HEAD") return res.end();
    res.end(readFileSync(file));
  }
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    if (opts.corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", opts.corsOrigin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") return send(res, 204);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, res, url.pathname.slice(4));
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      log("\u8BF7\u6C42\u5904\u7406\u5F02\u5E38", req.method, url.pathname, e);
      return send(res, 500, { error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF" });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const sockets = /* @__PURE__ */ new Map();
  const alive = /* @__PURE__ */ new WeakSet();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = url.pathname.match(/^\/ws\/rooms\/([A-Z0-9]{6})$/);
    const playerId = new URL(req.url || "/", "http://x").searchParams.get("playerId") ?? "";
    const token = new URL(req.url || "/", "http://x").searchParams.get("token") ?? "";
    const room = m ? rooms.get(m[1]) : void 0;
    if (!m || !room || room.closed || !/^[\w-]{1,40}$/.test(playerId) || !tokens.verify("room-v2:" + m[1], playerId, token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, m[1], playerId));
  });
  function onSocket(ws, code, playerId) {
    const room = rooms.get(code);
    if (!room) return ws.close(4404, "room closed");
    const key = `${code}:${playerId}`;
    const prev = sockets.get(key);
    if (prev && prev !== ws) {
      prev.send(JSON.stringify({ type: "kicked", reason: "\u4F60\u5DF2\u5728\u5176\u4ED6\u9875\u9762\u8FDB\u5165\u8BE5\u623F\u95F4" }));
      prev.close(4e3, "replaced");
    }
    sockets.set(key, ws);
    alive.add(ws);
    const unsubscribe = room.connect(playerId, (msg) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(msg));
      if (msg.type === "kicked" || msg.type === "closed") ws.close(1e3, msg.type);
    });
    let windowStart = Date.now();
    let count = 0;
    let burst = 0;
    ws.on("message", (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart > 1e3) {
        windowStart = now;
        burst = count > 20 ? burst + count : 0;
        count = 0;
      }
      if (++count > 20) {
        if (burst > 150) ws.close(4429, "too many messages");
        return;
      }
      if (isBinary) return;
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msg = parseClientMessage(parsed);
      if (!msg) return;
      const current = rooms.get(code);
      if (!current) return ws.close(4404, "room closed");
      current.handle(playerId, msg);
    });
    ws.on("pong", () => alive.add(ws));
    ws.on("close", () => {
      unsubscribe();
      if (sockets.get(key) === ws) sockets.delete(key);
    });
    ws.on("error", () => ws.terminate());
  }
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, 30 * 1e3);
  await new Promise((ok) => server.listen(opts.port, opts.host ?? "0.0.0.0", ok));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  if (!opts.quiet) log(`\u670D\u52A1\u5DF2\u542F\u52A8\uFF1Ahttp://localhost:${port}`);
  return {
    server,
    rooms,
    port,
    adminPassword,
    async close() {
      clearInterval(ping);
      clearInterval(sweep);
      clearInterval(duelTimer);
      duels.close();
      rooms.shutdown();
      for (const ws of wss.clients) ws.close(1012, "server restart");
      wss.close();
      await new Promise((ok) => server.close(() => ok()));
      server.closeAllConnections?.();
      store.close();
    }
  };
}

// server/index.ts
init_rtcfg();
init_settle();
var env = process.env;
var dataDir = env.DATA_DIR || join2(process.cwd(), "data");
setBalanceFetcher(async (uid) => {
  try {
    const r = await getBalance(uid);
    const v = Number((r && r.balance) ?? NaN);
    return Number.isNaN(v) ? null : v;
  } catch {
    return null;
  }
});
var app = await createApp({
  port: Number(env.PORT) || 8787,
  host: env.HOST || "0.0.0.0",
  dbFile: join2(dataDir, "poker.db"),
  staticDir: env.STATIC_DIR || join2(process.cwd(), "dist"),
  adminPassword: env.ADMIN_PASSWORD,
  sessionSecret: env.SESSION_SECRET,
  corsOrigin: env.CORS_ORIGIN,
  trustProxy: env.TRUST_PROXY === "1",
  maxRooms: Number(env.MAX_ROOMS) || 500
});
await startRtCfg();
var stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`\u6536\u5230 ${signal}\uFF0C\u6B63\u5728\u4FDD\u5B58\u623F\u95F4\u5E76\u5173\u95ED\u2026`);
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (e) => log("\u672A\u6355\u83B7\u7684\u5F02\u5E38", e));
process.on("unhandledRejection", (e) => log("\u672A\u5904\u7406\u7684 Promise \u62D2\u7EDD", e));
//# sourceMappingURL=index.mjs.map
