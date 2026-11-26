"""六合彩固定赔率。复用原后台鉴权、订单快照及结算事务。"""
import json
import re
from contextvars import ContextVar
from decimal import Decimal

KEY = "df_lhc_fixed_odds"
GROUPS = ("特码A", "正码", *("正" + n + "特" for n in "一二三四五六"), "特码头数", "特码尾数")
DEFAULT = {"特码A": 47}


def market(group, name):
    if group in GROUPS[:8] and re.fullmatch(r"0?[1-9]|[1-4][0-9]", name):
        return group
    if group == "特码头尾数" and re.fullmatch(r"[0-4]头|[0-9]尾", name):
        return "特码" + name[-1] + "数"


def install(core):
    original_set, original_num = core.conf_set, core.conf_num
    original_list, original_meta = core.df_plays, core.df_play_meta
    original_place, original_judge = core.df_place, core.df_judge
    core.db.DF_CONF_DEFAULT[KEY] = (json.dumps(DEFAULT), "六合彩固定赔率")
    fixed = ContextVar("lhc_fixed", default=None)

    def settings():
        return json.loads(core.conf_get(KEY, json.dumps(DEFAULT)))

    def save(key, value):
        if key == KEY:
            try:
                values = json.loads(value)
                if not isinstance(values, dict) or "特码A" not in values:
                    raise ValueError()
                for k, v in values.items():
                    if (k not in GROUPS or type(v) not in (int, float) or not 1 <= v <= 10000
                            or Decimal(str(v)).as_tuple().exponent < -3):
                        raise ValueError()
            except (TypeError, ValueError):
                raise core.Err(400, "固定赔率须为 1 至 10000，最多三位小数，且须配置特码")
        return original_set(key, value)

    def listings(no):
        result = original_list(no)
        if result.get("kind") == "lhc":
            values = settings()
            priority = [*GROUPS[:8], "特码头尾数"]
            result["groups"] = sorted(
                (g for g in result["groups"] if g["name"] != "GamesPlay_B"),
                key=lambda g: priority.index(g["name"]) if g["name"] in priority else len(priority))
            for group in result["groups"]:
                for item in group["items"]:
                    k = market(group["name"], item["name"])
                    if k in values:
                        item["odds"] = values[k]
        return result

    def metadata(no, rule_key):
        meta = original_meta(no, rule_key)
        if meta and meta.get("kind") == "lhc":
            k = market(meta["group"], meta["name"])
            if k:
                values = settings()
                if k in values:
                    meta = dict(meta, odds=values[k])
                    if fixed.get() is not None:
                        fixed.set(True)
        return meta

    def place(*args, **kwargs):
        scope = fixed.set(False)
        try:
            return original_place(*args, **kwargs)
        finally:
            fixed.reset(scope)

    def judge(meta, pick, numbers):
        k = market(meta.get("group"), str(meta.get("name"))) if meta.get("kind") == "lhc" else None
        if not k:
            return original_judge(meta, pick, numbers)
        balls = [int(v) for v in (numbers.split(",") if isinstance(numbers, str) else numbers)]
        if len(balls) != 7 or len(set(balls)) != 7 or not all(1 <= b <= 49 for b in balls):
            raise ValueError("无效六合彩开奖，暂停结算")
        name = str(meta["name"])
        if k == "特码头数":
            hit = balls[-1] // 10 == int(name[0])
        elif k == "特码尾数":
            hit = balls[-1] % 10 == int(name[0])
        elif k == "正码":
            hit = int(name) in balls[:6]
        elif k == "特码A":
            hit = int(name) == balls[-1]
        else:
            hit = int(name) == balls["一二三四五六".index(k[1])]
        return int(hit), "命中" if hit else "未中"

    core.conf_set, core.df_plays = save, listings
    core.df_play_meta, core.df_place, core.df_judge = metadata, place, judge
    core.conf_num = lambda key, default=0: 1 if key == "df_lhc_factor" and fixed.get() else original_num(key, default)
