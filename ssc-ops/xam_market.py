"""Dedicated New Macau daily market, Beijing time; SQLite deployments only."""
import json
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.request import urlopen
from zoneinfo import ZoneInfo

from lhc_odds import market
from macaujc import parse_draw

NO = "99001"
NAME = "新澳门六合彩"
ZONE = ZoneInfo("Asia/Shanghai")
ARCHIVE = Path("/var/lib/xam-draws/latest.json")
NEXT = "https://yongley.com/ajax/getNextTime.php?lottery=macaujc2_lhc"


def stamp(raw):
    return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S").replace(tzinfo=ZONE)


def issue_for(t):
    return t.strftime("%Y%j")


def publish(core, rows, schedule, now):
    checked = []
    for r in rows:
        draw = parse_draw(dict(expect=r["issue"], openTime=r["open_time"],
                               openCode=",".join([*r["regular"], r["special"]])))
        t = stamp(draw["open_time"])
        if draw["issue"] != issue_for(t) or t > now or (t.hour, t.minute) < (21, 26):
            raise ValueError("开奖日期或时间不匹配")
        checked.append((draw["issue"], ",".join(draw["regular"] + [draw["special"]]), draw["open_time"]))
    latest = max(checked)
    with core.db.tx() as c:
        existing = c.execute("SELECT name FROM df_lots WHERE game_no=?", (NO,)).fetchone()
        if existing and existing[0] != NAME:
            raise ValueError("盘口编号冲突")
        c.execute("INSERT OR IGNORE INTO df_lots(game_no,name,game_type,game_info,data_ftime,pshow,src,sort,enabled) VALUES(?,?,5,'每日一期 · 北京时间21:26封盘',5,1,'credit',0,1)", (NO, NAME))
        for issue, balls, opened in checked:
            prior = c.execute("SELECT numbers FROM df_draws WHERE game_no=? AND issue=?", (NO, issue)).fetchone()
            if prior and prior[0] != balls:
                raise ValueError("同期开奖冲突")
            c.execute("INSERT OR IGNORE INTO df_draws(game_no,issue,numbers,draw_time,ctime) VALUES(?,?,?,?,?)",
                      (NO, issue, balls, opened, int(now.timestamp())))
        c.execute("""CREATE TRIGGER IF NOT EXISTS xam_cutoff BEFORE INSERT ON df_orders
          WHEN NEW.game_no='99001' AND NOT EXISTS (
            SELECT 1 FROM df_current WHERE game_no=NEW.game_no AND issue=NEW.issue AND can_bet=1
            AND utime >= unixepoch()-240 AND unixepoch() < unixepoch(substr(draw_time,1,10)||' 21:26:00+08:00')
            AND NOT EXISTS (SELECT 1 FROM df_draws WHERE game_no=NEW.game_no AND issue=NEW.issue))
          BEGIN SELECT RAISE(ABORT,'新澳门六合彩已封盘'); END""")
    # A valid completed draw remains settleable when next-issue publication lags.
    pending = core.db.q("""SELECT DISTINCT o.issue FROM df_orders o JOIN df_draws d
        ON d.game_no=o.game_no AND d.issue=o.issue WHERE o.game_no=? AND o.status=0""", (NO,))
    for row in pending:
        core.df_settle(NO, row["issue"])
    with core.db.tx() as c:
        try:
            next_time = stamp(schedule["NextTime"])
            issue = str(schedule["NextQishu"])
        except (TypeError, ValueError, KeyError):
            c.execute("UPDATE df_current SET can_bet=0 WHERE game_no=?", (NO,))
            return
        if issue != issue_for(next_time) or issue_for(next_time - timedelta(days=1)) != latest[0]:
            c.execute("UPDATE df_current SET can_bet=0 WHERE game_no=?", (NO,))
            return
        close = next_time.replace(hour=21, minute=26, second=0)
        if next_time <= close:
            c.execute("UPDATE df_current SET can_bet=0 WHERE game_no=?", (NO,))
            return
        c.execute("INSERT OR REPLACE INTO df_current VALUES(?,?,?,?,?,?,?)",
                  (NO, issue, latest[0], latest[1], schedule["NextTime"], int(now < close), int(now.timestamp())))



def install(core):
    old_post, old_cur, old_list, old_place = core._df_post, core.df_cur, core.df_plays, core.df_place
    def post(ep, body, *args, **kwargs):
        if str(body.get("uGameNo")) == NO:
            raise ValueError("独立开奖源")
        return old_post(ep, body, *args, **kwargs)

    def current(no):
        result = old_cur(no)
        if str(no) == NO and result and result.get("draw_time"):
            close = stamp(result["draw_time"]).replace(hour=21, minute=26, second=0).timestamp()
            result["can_bet"] = bool(result["can_bet"] and time.time() < close and time.time()-result["utime"] < 240)
            result["close_at"] = int(close) if result["can_bet"] else min(int(close),int(time.time()))
        return result

    def plays(no):
        result = old_list(no)
        if str(no) == NO:
            groups = []
            for g in result["groups"]:
                items = [i for i in g["items"] if market(g["name"], i["name"])]
                if items:
                    groups.append(dict(g, items=items))
            result["groups"] = groups
        return result

    def place(uid, game_no, issue, rule_key, pick, amount, ip=""):
        if str(game_no) == NO:
            g, _, item = str(rule_key).partition("|")
            if not market(g, item) or pick != [item]:
                raise core.Err(400, "该投注项未开放")
            state = current(NO)
            if not state or not state["can_bet"] or str(issue) != state["issue"]:
                raise core.Err(400, "本期已封盘或期号已更新")
        return old_place(uid, game_no, issue, rule_key, pick, amount, ip)

    core._df_post, core.df_cur, core.df_plays, core.df_place = post, current, plays, place


def start(core):
    install(core)
    def poll():
        while True:
            try:
                if time.time() - ARCHIVE.stat().st_mtime > 900:
                    raise ValueError("开奖归档未及时更新")
                schedule = None
                try:
                    with urlopen(NEXT, timeout=12) as response:
                        schedule = json.loads(response.read(16384).decode("utf-8-sig"))
                except (ValueError, OSError) as exc:
                    print("下一期期号暂不可用", type(exc).__name__, flush=True)
                publish(core, json.loads(ARCHIVE.read_text()), schedule, datetime.now(ZONE))
            except Exception as exc:
                print("新澳门六合彩同步失败", type(exc).__name__, str(exc), flush=True)
            time.sleep(90)
    threading.Thread(target=poll, daemon=True, name="xam-market").start()
