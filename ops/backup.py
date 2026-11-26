"""Back up the two SQLite stores after operators have drained and stopped writers."""
import argparse
import os
from pathlib import Path
import sqlite3
import tempfile


def snapshot(source, destination):
    with sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True) as reader:
        with sqlite3.connect(destination) as writer:
            reader.backup(writer)
            if writer.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise RuntimeError(f"Integrity check failed: {source.name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wallet", type=Path)
    parser.add_argument("poker", type=Path)
    parser.add_argument("output_parent", type=Path)
    args = parser.parse_args()
    if args.wallet.samefile(args.poker):
        parser.error("Expected two different databases")
    os.umask(0o077)
    args.output_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.output_parent, prefix=".pending-") as tmp:
        stage = Path(tmp)
        snapshot(args.wallet, stage / "ssc_ops.db")
        snapshot(args.poker, stage / "poker.db")
        completed = args.output_parent / ("backup-" + stage.name.removeprefix(".pending-"))
        stage.rename(completed)
        print(completed)


if __name__ == "__main__":
    main()
