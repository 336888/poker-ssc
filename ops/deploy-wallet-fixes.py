"""Publish the two November wallet fixes from a local Git checkout on Debian."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time

BASE = "f8ad95a72b08cc9bbd345ad79f7b8c7475a22d0e"
# Fingerprints of the two rebuilt artifacts from the previous live release.
PREVIOUS_LIVE = {"dist-server/index.mjs":"741a88c3541f74a9147d7167ff1a3d4832eafbaa",
                 "dist-server/index.mjs.map":"e00e0a8a83fb67ad7894eb483c3a2c8291760047"}
PREFIX = "poker-online/"
HOME_PAGE = "ssc-ops/web/index.html"
UNIT = "poker.service"


def run(*args):
    return subprocess.check_output(args)


def replace(source, target):
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as tmp:
        staging = Path(tmp.name)
    try:
        shutil.copy2(source, staging)
        if target.exists():
            stat = target.stat()
            os.chown(staging, stat.st_uid, stat.st_gid)
            staging.chmod(stat.st_mode & 0o777)
        else:
            staging.chmod(0o644)
        os.replace(staging, target)
    finally:
        staging.unlink(missing_ok=True)


def publish(items, backup, restart, verify):
    originals = []
    for index, (_, dest) in enumerate(items):
        saved = backup / str(index) if dest.exists() else None
        if saved:
            shutil.copy2(dest, saved)
        originals.append((dest, saved))
    (backup / "files.json").write_text(json.dumps(
        [(str(dest), str(saved) if saved else None) for dest, saved in originals]))
    applied = 0
    restarted = False
    try:
        for source, dest in items:
            replace(source, dest)
            applied += 1
        restarted = True
        restart()
        verify()
    except BaseException:
        for dest, saved in reversed(originals[:applied]):
            if saved:
                replace(saved, dest)
            else:
                dest.unlink(missing_ok=True)
        if restarted:
            restart()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--release", required=True, help="完整的目标 Git 提交号")
    args = parser.parse_args()
    REV = args.release
    if len(REV)!=40 or any(c not in "0123456789abcdef" for c in REV):
        parser.error("请指定完整的提交号")
    repo = Path("/opt/poker-ssc")
    live = Path("/opt/ssc-ops/web/index.html")
    lock = open("/run/lock/poker-wallet-release.lock", "a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def git(*args):
        return run("git", "-C", repo, *args)

    git("cat-file", "-e", REV + "^{commit}")
    pid = int(run("systemctl", "show", UNIT, "-p", "MainPID", "--value"))
    if pid < 1:
        raise RuntimeError("棋牌服务没有运行")
    proc = Path("/proc") / str(pid)
    root = (proc / "cwd").resolve(strict=True)
    bundle = (root / "dist-server/index.mjs").resolve()
    argv = (proc / "cmdline").read_bytes().split(b"\0")[1:]
    if not any((root / os.fsdecode(arg)).resolve() == bundle for arg in argv if arg):
        raise RuntimeError("当前进程启动文件与部署布局不符")
    env = dict(item.split(b"=", 1) for item in (proc / "environ").read_bytes().split(b"\0") if b"=" in item)
    static = root / os.fsdecode(env.get(b"STATIC_DIR") or b"dist")
    data = root / os.fsdecode(env.get(b"DATA_DIR") or b"data")
    node = (proc / "exe").resolve(strict=True)
    def http(path, *options):
        return run("curl", "-ksS", "--max-time", "5", *options, "https://127.0.0.1" + path)

    def room_count():
        health = json.loads(http("/poker/api/health", "-f"))
        if health.get("ok") is not True or type(health.get("rooms")) is not int:
            raise RuntimeError("无法确认房间状态")
        if "games" in health:
            if set(health["games"]) != {"doudizhu","paodekuai","zjh","nn"}:
                raise RuntimeError("四种游戏的房间统计不完整")
            return health["rooms"]
        # The old process only reports the two RoomManager games.
        wallet = Path(os.fsdecode(env.get(b"CARD_WALLET_DB") or b"/opt/ssc-ops/ssc_ops.db"))
        with sqlite3.connect((root/wallet).resolve().as_uri()+"?mode=ro",uri=True) as db:
            return health["rooms"] + db.execute("SELECT count(*) FROM card_duels WHERE phase IN ('wait','play')").fetchone()[0]

    with tempfile.TemporaryDirectory() as temp:
        stage = Path(temp)
        items = []
        changed = git("diff", "--name-only", BASE, REV, "--", PREFIX+"dist", PREFIX+"dist-server").decode().splitlines()
        for index, path in enumerate(changed):
            rel = Path(path).relative_to(PREFIX)
            dest = static.joinpath(*rel.parts[1:]) if rel.parts[0] == "dist" else root / rel
            source = stage / (str(index) + dest.suffix)
            content = git("show", REV + ":" + path)
            source.write_bytes(content)
            if dest.exists():
                current = dest.read_bytes()
                if current == content:
                    continue
                # Only replace a known release file. Preserve local customizations.
                for ref in (BASE, REV + "^"):
                    known = subprocess.run(["git","-C",repo,"show",ref+":"+path],capture_output=True)
                    if known.returncode == 0 and known.stdout == current:
                        break
                else:
                    if run("git","hash-object",dest).decode().strip() != PREVIOUS_LIVE.get(str(rel)):
                        raise RuntimeError("发现独立修改，已停止覆盖 " + str(dest))
            if dest == bundle:
                run(node, "--check", source)
            items.append((source, dest))
        old, base, new = (stage / name for name in ("live","base","new"))
        shutil.copy2(live, old)
        base.write_bytes(git("show", BASE + ":" + HOME_PAGE))
        new.write_bytes(git("show", REV + ":" + HOME_PAGE))
        merged = stage / "merged"
        merged.write_bytes(run("git", "merge-file", "-p", old, base, new))
        if merged.read_bytes() != old.read_bytes():
            items.append((merged,live))
        def verify():
            for attempt in range(15):
                try:
                    room_count()
                    break
                except (ValueError, RuntimeError, subprocess.SubprocessError):
                    if attempt == 14:
                        raise
                    time.sleep(1)
            for path in ("me/balance", "lastresult"):
                if http("/poker/api/"+path, "-o","/dev/null","-w","%{http_code}") != b"401":
                    raise RuntimeError("匿名访问验证失败 " + path)
            for path in changed:
                if path.startswith(PREFIX+"dist/"):
                    uri = "/poker/" + path.removeprefix(PREFIX+"dist/")
                    if http(uri, "-f") != git("show",REV+":"+path):
                        raise RuntimeError("线上静态文件不匹配 " + uri)
            if b"fetch('/poker/api/sso'" not in http("/", "-f"):
                raise RuntimeError("主站登录入口验证失败")

        count = room_count()
        print(f"待更新 {len(items)} 个文件，当前 {count} 个房间", flush=True)
        if not args.apply:
            return
        if not items:
            verify()
            return
        if count:
            raise RuntimeError("还有房间，暂缓重启")
        parent = Path("/var/backups/poker-wallet-release")
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        backup = Path(tempfile.mkdtemp(dir=parent))
        print("备份目录",backup,flush=True)
        src = sqlite3.connect((data/"poker.db").resolve().as_uri()+"?mode=ro",uri=True)
        dst = sqlite3.connect(backup/"poker.db")
        try:
            src.backup(dst)
            if dst.execute("PRAGMA quick_check").fetchone() != ("ok",):
                raise RuntimeError("数据库备份验证失败")
        finally:
            dst.close()
            src.close()
        gate = data/"pause-matchmaking"
        with gate.open("x"):
            pass
        try:
            if room_count() or live.read_bytes() != old.read_bytes():
                raise RuntimeError("部署期间现场状态发生变化")
            # First upgrade only: the old binary does not observe the drain marker.
            # Stop its listener and verify its final room snapshot before replacing files.
            if "games" not in json.loads(http("/poker/api/health", "-f")):
                run("systemctl","stop",UNIT)
                try:
                    with sqlite3.connect((data/"poker.db").resolve().as_uri()+"?mode=ro",uri=True) as d:
                        if d.execute("SELECT count(*) FROM rooms").fetchone()[0]:
                            raise RuntimeError("停机检查发现房间，已取消更新")
                    wallet = root / os.fsdecode(env.get(b"CARD_WALLET_DB") or b"/opt/ssc-ops/ssc_ops.db")
                    with sqlite3.connect(wallet.resolve().as_uri()+"?mode=ro",uri=True) as d:
                        if d.execute("SELECT count(*) FROM card_duels WHERE phase IN ('wait','play')").fetchone()[0]:
                            raise RuntimeError("停机检查发现五人牌桌，已取消更新")
                    publish(items, backup, lambda: run("systemctl","restart",UNIT), verify)
                finally:
                    run("systemctl","start",UNIT)
            else:
                publish(items, backup, lambda: run("systemctl","restart",UNIT), verify)
        finally:
            gate.unlink()
        print("已发布并验证",REV)


if __name__ == "__main__":
    main()
