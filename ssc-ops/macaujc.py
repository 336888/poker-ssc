"""新澳门六合彩开奖适配器与特码赔率索引。"""
import argparse
import json
import re
from datetime import datetime
from urllib.request import urlopen

LATEST = "https://macaumarksix.com/api/macaujc2.com"
HISTORY = "https://history.macaumarksix.com/history/macaujc2/y/{}"
SPECIAL = {f"特码|{n:02}": 47 for n in range(1, 50)}


def parse_draw(row):
    issue = str(row["expect"])
    balls = [v.strip() for v in row["openCode"].split(",")]
    if (not re.fullmatch(r"[0-9]+", issue) or len(balls) != 7
            or any(not re.fullmatch(r"0?[1-9]|[1-4][0-9]", b) for b in balls)):
        raise ValueError("期号或开奖号码无效")
    balls = [f"{int(b):02}" for b in balls]
    if len(set(balls)) != 7:
        raise ValueError("同一期号码重复")
    datetime.strptime(row["openTime"], "%Y-%m-%d %H:%M:%S")
    return dict(issue=issue, open_time=row["openTime"], regular=balls[:6], special=balls[6])


def read_feed(year=None):
    url = HISTORY.format(year) if year is not None else LATEST
    with urlopen(url, timeout=10) as response:
        payload = json.load(response)
    if year is not None:
        if payload["code"] != 200:
            raise ValueError("历史开奖接口返回失败")
        payload = payload["data"]
    if not isinstance(payload, list) or not payload:
        raise ValueError("没有完整开奖记录")
    return [parse_draw(row) for row in payload]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--odds", action="store_true", help="输出 49 个特码投注项的含本金赔率")
    group.add_argument("--year", type=int, help="读取指定年份的历史开奖")
    args = parser.parse_args()
    print(json.dumps(SPECIAL if args.odds else read_feed(args.year), ensure_ascii=False, indent=2))
