"""Reconcile pending leave fees against immutable wallet receipts without moving funds."""
import json
import math
import os
from pathlib import Path
import sqlite3
import subprocess
from contextlib import closing


def matches(raw, uid, amount):
    try:
        moves = json.loads(raw)
    except (TypeError, ValueError, UnicodeError):
        return False
    if not isinstance(moves, list) or len(moves) != 1 or not isinstance(moves[0], dict):
        return False
    move = moves[0]
    delta = move.get("delta")
    return (type(delta) in (float, int) and type(amount) in (float, int)
            and math.isfinite(amount) and amount >= 0 and move.get("uid") == uid
            and delta == -amount)


def reconcile(game_path, wallet_path):
    cleared = 0
    with closing(sqlite3.connect(game_path.resolve().as_uri() + "?mode=rw", uri=True,
                                 timeout=2)) as game:
        if not game.execute("SELECT 1 FROM pending_leave_fees LIMIT 1").fetchone():
            return 0, 0
        with closing(sqlite3.connect(wallet_path.resolve().as_uri() + "?mode=ro", uri=True,
                                     timeout=2)) as wallet:
            table = wallet.execute("SELECT 1 FROM sqlite_master WHERE type='table' "
                                   "AND name='poker_round_receipts'").fetchone()
            if table:
                cursor = 0
                while True:
                    rows = game.execute("SELECT rowid,id,uid,amount FROM pending_leave_fees "
                                        "WHERE rowid>? ORDER BY rowid LIMIT 100", (cursor,)).fetchall()
                    if not rows:
                        break
                    for cursor, ref, uid, amount in rows:
                        receipt = wallet.execute("SELECT receipt FROM poker_round_receipts WHERE id=?",
                                                 (ref,)).fetchone()
                        if receipt and matches(receipt[0], uid, amount):
                            with game:
                                cleared += game.execute("DELETE FROM pending_leave_fees WHERE "
                                                        "rowid=? AND id=? AND uid=? AND amount=?",
                                                        (cursor, ref, uid, amount)).rowcount
        pending = game.execute("SELECT count(*) FROM pending_leave_fees").fetchone()[0]
        return cleared, pending


def main():
    raw = subprocess.check_output(["systemctl", "show", "poker.service", "-p", "MainPID", "--value"])
    pid = int(raw)
    if pid <= 0:
        return
    proc = Path("/proc") / str(pid)
    root = (proc / "cwd").resolve(strict=True)
    env = dict(item.split(b"=", 1) for item in (proc / "environ").read_bytes().split(bytes([0])) if b"=" in item)
    game = root / os.fsdecode(env.get(b"DATA_DIR") or b"data") / "poker.db"
    wallet = root / os.fsdecode(env.get(b"CARD_WALLET_DB") or b"/opt/ssc-ops/ssc_ops.db")
    cleared, pending = reconcile(game, wallet)
    print(f"leave-fee reconciliation: cleared={cleared} pending={pending}")


if __name__ == "__main__":
    main()
