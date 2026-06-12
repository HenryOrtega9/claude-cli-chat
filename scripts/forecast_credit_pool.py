#!/usr/bin/env python3
"""
Forecast plugin drain rate against the Agent SDK credit pool.
Reads ~/.claude/projects/<vault-hash>/*.jsonl, filters to plugin sessions,
sums per-message usage, prices at API list rates, projects monthly burn.

Usage:
  python3 scripts/forecast_credit_pool.py --vault "/path/to/My Vault"
  python3 scripts/forecast_credit_pool.py --vault-hash <hash>      # explicit slug
  python3 scripts/forecast_credit_pool.py --vault ... --entrypoint cli
"""
import argparse, json, os, re, glob
from collections import defaultdict
from datetime import datetime

DEFAULT_ENTRYPOINT = "claude-cli-chat-plugin"

def project_slug(path):
    """Claude Code project-dir slug: every non-alphanumeric char becomes '-'."""
    return re.sub(r"[^A-Za-z0-9]", "-", os.path.abspath(os.path.expanduser(path)))

# May 2026 published API rates per million tokens (USD).
# Update if Anthropic publishes a different Agent SDK schedule.
PRICES = {
    "claude-sonnet-4-6": {"in": 3.0,  "out": 15.0, "cache_5m": 3.75,  "cache_1h": 6.0,  "cache_read": 0.30},
    "claude-sonnet-4-5": {"in": 3.0,  "out": 15.0, "cache_5m": 3.75,  "cache_1h": 6.0,  "cache_read": 0.30},
    "claude-opus-4-7":   {"in": 15.0, "out": 75.0, "cache_5m": 18.75, "cache_1h": 30.0, "cache_read": 1.50},
    "claude-opus-4-6":   {"in": 15.0, "out": 75.0, "cache_5m": 18.75, "cache_1h": 30.0, "cache_read": 1.50},
    "claude-haiku-4-5":  {"in": 1.0,  "out": 5.0,  "cache_5m": 1.25,  "cache_1h": 2.0,  "cache_read": 0.10},
}

def price_for(model):
    for k, v in PRICES.items():
        if model.startswith(k): return v
    return PRICES["claude-sonnet-4-6"]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", help="vault path; the project slug is derived from it")
    ap.add_argument("--vault-hash", help="explicit project-dir slug under ~/.claude/projects/")
    ap.add_argument("--entrypoint", default=DEFAULT_ENTRYPOINT,
                    help="filter by entrypoint field (use 'all' to skip filter)")
    ap.add_argument("--pool", type=float, default=100.0, help="credit pool $ (default $100)")
    args = ap.parse_args()

    vault_hash = args.vault_hash or (project_slug(args.vault) if args.vault else None)
    if not vault_hash:
        ap.error("pass --vault <path> or --vault-hash <slug>")
    vault = os.path.expanduser(f"~/.claude/projects/{vault_hash}")
    if not os.path.isdir(vault):
        raise SystemExit(f"No such directory: {vault}")

    by_model = defaultdict(lambda: {"in":0,"out":0,"c5":0,"c1h":0,"cr":0,"msgs":0})
    sessions = set()
    first_ts = last_ts = None
    files_scanned = 0

    for path in sorted(glob.glob(os.path.join(vault, "*.jsonl"))):
        files_scanned += 1
        sid = os.path.basename(path).replace(".jsonl","")
        session_matched = False
        with open(path, "r", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line: continue
                try: d = json.loads(line)
                except: continue
                ep = d.get("entrypoint","")
                if args.entrypoint != "all" and ep != args.entrypoint:
                    continue
                session_matched = True
                ts = d.get("timestamp")
                if ts:
                    try:
                        t = datetime.fromisoformat(ts.replace("Z","+00:00"))
                        if not first_ts or t < first_ts: first_ts = t
                        if not last_ts or t > last_ts:   last_ts = t
                    except: pass
                msg = d.get("message") or {}
                usage = msg.get("usage")
                if not isinstance(usage, dict): continue
                model = msg.get("model","unknown")
                m = by_model[model]
                m["in"]  += usage.get("input_tokens",0) or 0
                m["out"] += usage.get("output_tokens",0) or 0
                cc = usage.get("cache_creation") or {}
                m["c5"]  += cc.get("ephemeral_5m_input_tokens",0) or 0
                m["c1h"] += cc.get("ephemeral_1h_input_tokens",0) or 0
                m["cr"]  += usage.get("cache_read_input_tokens",0) or 0
                m["msgs"] += 1
        if session_matched: sessions.add(sid)

    print(f"\nentrypoint filter: {args.entrypoint}")
    print(f"files scanned:     {files_scanned}")
    print(f"sessions matched:  {len(sessions)}")
    if first_ts and last_ts:
        days = (last_ts - first_ts).total_seconds() / 86400
        print(f"window:            {first_ts.date()} -> {last_ts.date()}  ({days:.1f} days)")
    else:
        days = 0
        print("window:            (no data)")
    print()

    if not by_model:
        print("No matching usage data found.")
        return

    print(f"{'Model':<28} {'Msgs':>6} {'In M':>8} {'Out M':>8} {'CW M':>8} {'CR M':>9} {'Cost':>10}")
    print("-"*90)
    total = 0.0
    for model, m in sorted(by_model.items()):
        if m["msgs"] == 0: continue
        p = price_for(model)
        cost = ((m["in"]/1e6)*p["in"] + (m["out"]/1e6)*p["out"]
                + (m["c5"]/1e6)*p["cache_5m"] + (m["c1h"]/1e6)*p["cache_1h"]
                + (m["cr"]/1e6)*p["cache_read"])
        total += cost
        print(f"{model:<28} {m['msgs']:>6} {m['in']/1e6:>8.3f} {m['out']/1e6:>8.3f} "
              f"{(m['c5']+m['c1h'])/1e6:>8.3f} {m['cr']/1e6:>9.3f} ${cost:>9.2f}")
    print("-"*90)
    print(f"{'TOTAL':<28} {'':>6} {'':>8} {'':>8} {'':>8} {'':>9} ${total:>9.2f}")

    if days > 0:
        per_day = total / days
        print(f"\nper day:                 ${per_day:.2f}")
        print(f"30-day projection:       ${per_day*30:.2f}")
        if per_day > 0:
            print(f"${args.pool:.0f} pool exhaustion: {args.pool/per_day:.1f} days "
                  f"({(args.pool/per_day)/30*100:.0f}% of a month)")
        else:
            print(f"${args.pool:.0f} pool exhaustion: n/a (zero matched cost)")

if __name__ == "__main__":
    main()
