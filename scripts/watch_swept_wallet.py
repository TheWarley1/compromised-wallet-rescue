#!/usr/bin/env python3
"""Read-only watcher: logs arrivals and departures with timestamps.

The latency between an arrival and its disappearance is the measurement that
decides whether a rescue race is winnable. This records that distribution; it
never signs anything.

    python3 scripts/watch_swept_wallet.py --address <wallet> [--poll 2] [--log path]
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
SECRETS_DIR = os.environ.get("SECRETS_DIR", os.path.expanduser("~/.hermes/.secrets"))


def read_secret(name, default=None):
    path = os.path.join(SECRETS_DIR, name)
    if not os.path.exists(path):
        return default
    with open(path) as fh:
        return fh.read().strip()


def rpc_url():
    helius = read_secret("helius_key")
    if helius:
        return f"https://mainnet.helius-rpc.com/?api-key={helius}"
    return os.environ.get("PUBLIC_RPC", "https://api.mainnet-beta.solana.com")


class Watcher:
    def __init__(self, address, poll, log_path, telegram=("", "")):
        self.address = address
        self.poll = poll
        self.log_path = log_path
        self.tg_token, self.tg_chat = telegram
        self.url = rpc_url()

    def log(self, msg):
        line = f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
        print(line, flush=True)
        os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
        with open(self.log_path, "a") as fh:
            fh.write(line + "\n")

    def telegram(self, msg):
        if not (self.tg_token and self.tg_chat):
            return
        try:
            req = urllib.request.Request(
                f"https://api.telegram.org/bot{self.tg_token}/sendMessage",
                data=json.dumps({"chat_id": self.tg_chat, "text": msg}).encode(),
                headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=15).read()
        except Exception as exc:  # noqa: BLE001
            self.log(f"telegram failed: {str(exc)[:60]}")

    def rpc(self, method, params):
        req = urllib.request.Request(
            self.url,
            data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
            headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
        return json.loads(urllib.request.urlopen(req, timeout=25).read().decode())

    def snapshot(self):
        found = {}
        try:
            res = self.rpc("getTokenAccountsByOwner",
                           [self.address, {"programId": TOKEN_PROGRAM}, {"encoding": "jsonParsed"}])
            for acc in res.get("result", {}).get("value", []):
                info = acc["account"]["data"]["parsed"]["info"]
                found[info["mint"]] = {
                    "ui": info["tokenAmount"].get("uiAmount"),
                    "raw": info["tokenAmount"].get("amount"),
                }
        except Exception as exc:  # noqa: BLE001
            self.log(f"poll error: {str(exc)[:70]}")
        try:
            bal = self.rpc("getBalance", [self.address]).get("result", {}).get("value", 0) / 1e9
        except Exception:  # noqa: BLE001
            bal = None
        return found, bal

    def run(self):
        self.log(f"watching {self.address} every {self.poll}s -> {self.log_path}")
        prev, prev_bal = self.snapshot()
        self.log(f"baseline: {len(prev)} token account(s), SOL={prev_bal}")
        seen_at = {}
        while True:
            time.sleep(self.poll)
            cur, bal = self.snapshot()
            now = time.time()
            for mint, info in cur.items():
                if mint not in prev:
                    seen_at[mint] = now
                    self.log(f"INCOMING {info['ui']} {mint} | SOL {prev_bal} -> {bal}")
                    self.telegram(f"Token landed in the swept wallet\n{info['ui']} {mint}")
                elif info.get("raw") != prev[mint].get("raw"):
                    self.log(f"CHANGED {mint} {prev[mint]['ui']} -> {info['ui']}")
            for mint, info in prev.items():
                if mint not in cur:
                    gap = f"{now - seen_at[mint]:.1f}s after arrival" if mint in seen_at else "previously held"
                    self.log(f"GONE {info['ui']} {mint} | {gap}")
                    self.telegram(f"Token left the swept wallet: {info['ui']} {mint[:12]}... ({gap})")
            if bal is not None and prev_bal is not None and abs(bal - prev_bal) > 1e-9:
                self.log(f"SOL balance {prev_bal} -> {bal}")
            prev, prev_bal = cur, bal


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", default=os.environ.get("VICTIM"))
    ap.add_argument("--poll", type=float, default=2.0)
    ap.add_argument("--log", default=os.path.expanduser("~/.hermes/logs/watch_swept_wallet.log"))
    args = ap.parse_args()
    if not args.address:
        print("need --address or VICTIM", file=sys.stderr)
        return 2
    tg = (read_secret("telegram_bot_token", "") or os.environ.get("TELEGRAM_BOT_TOKEN", ""),
          os.environ.get("TELEGRAM_CHAT", ""))
    Watcher(args.address, args.poll, args.log, tg).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
