# -*- coding: utf-8 -*-
import sys, os, marshal, zlib, types, traceback, hashlib

_H = os.path.dirname(os.path.abspath(__file__))
_L = os.path.join(_H, "lib")
_SEC = os.environ.get("SSC_SECRET", "").encode()


def _ks(tag, n):
    out = b""
    i = 0
    while len(out) < n:
        out += hashlib.sha512(_SEC + b"|" + tag + b"|" + i.to_bytes(4, "big")).digest()
        i += 1
    return out[:n]


def _load(name):
    if not _SEC:
        raise RuntimeError("env")
    with open(os.path.join(_L, name + ".dat"), "rb") as f:
        blob = f.read()
    k = _ks(name.encode(), len(blob))
    raw = bytes(a ^ b for a, b in zip(blob, k))
    return marshal.loads(zlib.decompress(raw))


def main():
    names = ["db", "game", "captcha", "chain", "collector", "roulette", "core"]
    for n in names:
        m = types.ModuleType(n)
        m.__dict__["__name__"] = n
        sys.modules[n] = m
    for n in names:
        exec(_load(n), sys.modules[n].__dict__)
    from lhc_odds import install
    install(sys.modules["core"])
    if os.path.isfile(os.path.join(_H, "xam-market.enabled")):
        from xam_market import start
        start(sys.modules["core"])
    g = {"__name__": "__main__", "__file__": os.path.join(_H, "app.py"),
         "__package__": None, "__builtins__": __builtins__}
    exec(_load("app"), g)


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--check"]:
            for name in ("db", "game", "captcha", "chain", "collector", "roulette", "core", "app"):
                if not isinstance(_load(name), types.CodeType):
                    raise RuntimeError("invalid packaged module: " + name)
            print("8 packaged modules readable")
        else:
            main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
