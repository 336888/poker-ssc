"""同步新澳门六合彩归档，原子发布最近十期 JSON。"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from urllib.request import urlopen

from macaujc import parse_draw

SOURCE = "https://yongley.com/ajax/getCodeList.php?num=10&lottery=macaujc2_lhc"


def sync(database, output):
    with urlopen(SOURCE, timeout=15) as response:
        payload = json.loads(response.read(256001).decode("utf-8-sig"))
    if not isinstance(payload, list) or not payload:
        raise ValueError("开奖源未返回记录")
    with sqlite3.connect(database) as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE IF NOT EXISTS draws(issue TEXT PRIMARY KEY, record TEXT NOT NULL)")
        for item in payload:
            if item["lottery"] != "新澳门六合彩":
                raise ValueError("彩种不匹配")
            draw = parse_draw(dict(expect=item["qishu"], openTime=item["time"],
                                   openCode=",".join(c["number"] for c in item["code"])))
            if len(draw["issue"]) != 7 or draw["issue"][:4] != draw["open_time"][:4]:
                raise ValueError("期号与年份不匹配")
            value = json.dumps(draw, ensure_ascii=False)
            old = db.execute("SELECT record FROM draws WHERE issue=?", (draw["issue"],)).fetchone()
            if old and old[0] != value:
                raise ValueError("同一期返回不同记录：" + draw["issue"])
            db.execute("INSERT OR IGNORE INTO draws VALUES (?,?)", (draw["issue"], value))
        recent = [json.loads(r[0]) for r in db.execute("SELECT record FROM draws ORDER BY issue DESC LIMIT 10")]
    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as tmp:
        name = tmp.name
        try:
            tmp.write(json.dumps(recent, ensure_ascii=False).encode())
            tmp.flush()
            os.fchmod(tmp.fileno(), 0o644)
            os.replace(name, output)
        finally:
            Path(name).unlink(missing_ok=True)
    print("最新期号", recent[0]["issue"], "本次读取", len(payload), flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("database", type=Path)
    p.add_argument("output", type=Path)
    args = p.parse_args()
    sync(args.database, args.output)
