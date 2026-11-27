"""Pricing for newly accepted main-site SQLite lottery orders."""
import json
import sqlite3
from decimal import Decimal, ROUND_HALF_UP
from types import FunctionType

CENT = Decimal("0.01")
OPEN_BETS = "SELECT * FROM bets WHERE lot=? AND issue=? AND status=0"


def migrate(connection):
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        if "pricing_version" not in {row[1] for row in connection.execute("PRAGMA table_info(bets)")}:
            connection.execute("ALTER TABLE bets ADD COLUMN pricing_version INTEGER")
        connection.execute("CREATE TABLE IF NOT EXISTS lottery_price_versions "
                           "(id INTEGER PRIMARY KEY, settings TEXT NOT NULL UNIQUE)")
        connection.execute("""CREATE TRIGGER IF NOT EXISTS lottery_capture_price AFTER INSERT ON bets BEGIN
            INSERT OR IGNORE INTO lottery_price_versions(settings)
              VALUES(coalesce(nullif((SELECT v FROM settings WHERE k='odds'),''),'{}'));
            UPDATE bets SET pricing_version=(SELECT id FROM lottery_price_versions WHERE settings=
              coalesce(nullif((SELECT v FROM settings WHERE k='odds'),''),'{}')) WHERE id=NEW.id;
        END""")


def payout(game, row, codes, numbers, config):
    cents = Decimal(str(row["amount"])) * 100
    if cents != cents.to_integral_value() or not codes or len(codes) != row["bets_count"]:
        raise ValueError("投注金额或注数无法核对")
    unit, remainder = divmod(int(cents), len(codes))
    total = Decimal(0)
    hits = 0
    for i, code in enumerate(codes):
        if game.judge(row["play"], row["extra"], code, numbers):
            rate = Decimal(str(game.odds_of(row["play"], code, config)))
            stake = Decimal(unit + (i < remainder)) / 100
            total += (stake * rate).quantize(CENT, rounding=ROUND_HALF_UP)
            hits += 1
    return hits, float(total)


class Proxy:
    def __init__(self, target):
        self.target = target

    def __getattr__(self, name):
        return getattr(self.target, name)


def install(core, database):
    if core.db.MYSQL_DSN:
        return
    with sqlite3.connect(database, timeout=10) as connection:
        migrate(connection)
    original = core.settle_issue

    def settle(connection, lot, issue, nums):
        game, db = Proxy(core.G), Proxy(core.db)
        versions = {}
        current = None

        def rows(data):
            nonlocal current
            for current in data:
                yield current

        def query(sql, *args, **kwargs):
            result = core.db.q(sql, *args, **kwargs)
            return rows(result) if sql == OPEN_BETS else result

        def price(play, extra, codes, numbers, each, overrides):
            if current is None:
                raise RuntimeError("未取得本局投注明细")
            version = current["pricing_version"]
            if version is None:
                return core.G.settle_bet(play, extra, codes, numbers, each, overrides)
            if version not in versions:
                config = connection.execute("SELECT settings FROM lottery_price_versions WHERE id=?",
                                            (version,)).fetchone()
                if not config:
                    raise ValueError("缺少投注赔率快照")
                versions[version] = json.loads(config[0])
            return payout(core.G, current, codes, numbers, versions[version])

        db.q = query
        game.settle_bet = price
        scope = dict(original.__globals__, db=db, G=game)
        return FunctionType(original.__code__, scope, closure=original.__closure__)(connection, lot, issue, nums)

    core.settle_issue = settle
