#!/usr/bin/env python3
"""Runs every query of every provisioned omp-usage dashboard through Grafana
(/api/ds/query) and fails on query errors or on panels without data.

    GRAFANA_URL=http://127.0.0.1:3000 python3 check_panels.py [--range 21d]

Dashboard variables are replaced with test values (All = .*); Grafana itself
expands $__range, $__interval and $__rate_interval.
"""
from __future__ import annotations

import argparse
import base64
import datetime
import json
import os
import re
import sys
import time
import urllib.request

URL = os.environ.get("GRAFANA_URL", "http://127.0.0.1:3000")
AUTH = "Basic " + base64.b64encode(os.environ.get("GRAFANA_AUTH", "admin:admin").encode()).decode()

VALUES = {
    "datasource": "prometheus",
    "job": "omp_usage",
    "provider": ".*",
    "model": ".*",
    "bucket": "1d",
    "compare": "7d",
    "budget": "50",
    "reference": ".*",
    "whatif_model": ".*",
    "price_input": "0.15",
    "price_output": "0.6",
    "price_cache_read": "0.015",
    "price_cache_write": "0",
    "local_provider": "llama.cpp",
    "llm_job": "llm",
}
# Single-value dashboards
OVERRIDES = {
    "omp-usage-model": {"provider": "llama.cpp", "model": "qwen3.6-35b-a3b"},
}
# Panels allowed to be empty with the synthetic data (documented reason).
MAY_BE_EMPTY = {
    ("omp-usage-exporter", "Unresolved pricing entries"): False,
}


def api(path: str, body: dict | None = None):
    req = urllib.request.Request(URL + path, method="POST" if body else "GET",
                                 headers={"Authorization": AUTH, "Content-Type": "application/json"},
                                 data=json.dumps(body).encode() if body else None)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def interpolate(expr: str, values: dict) -> str:
    def sub(m):
        name = m.group(1) or m.group(2)
        if name.startswith("__"):
            return m.group(0)
        if name not in values:
            raise KeyError(f"unknown variable ${name}")
        return values[name]
    return re.sub(r"\$\{(\w+)\}|\$(\w+)", sub, expr)


def interval_ms(s: str) -> int:
    n, unit = int(s[:-1]), s[-1]
    return n * {"s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}[unit]


def window_start(time_from: str, to_s: int) -> int:
    """Start of a panel window: "now/M" (month to date) or a duration like "21d"."""
    if time_from == "now/M":
        t = datetime.datetime.fromtimestamp(to_s, datetime.timezone.utc)
        return int(t.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp())
    return to_s - interval_ms(time_from.removeprefix("now-")) // 1000


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--range", default="21d")
    ap.add_argument("--to", type=int, default=None,
                    help="end of the checked window, epoch seconds (default: now). "
                         "Use the last sample time when checking backfilled data.")
    args = ap.parse_args()
    to_s = args.to or int(time.time())

    dashboards = api("/api/search?tag=omp-usage&type=dash-db")
    failures, checked = [], 0
    for d in sorted(dashboards, key=lambda x: x["uid"]):
        dash = api(f"/api/dashboards/uid/{d['uid']}")["dashboard"]
        values = {**VALUES, **OVERRIDES.get(dash["uid"], {})}
        for p in dash["panels"]:
            if p["type"] in ("row", "text"):
                continue
            pvalues = dict(values)
            if p.get("repeat") == "reference":
                pvalues["reference"] = "anthropic/claude-sonnet-4.5"
            frm = window_start(p.get("timeFrom") or args.range, to_s)
            interval = interpolate(p.get("interval", "5m"), pvalues)
            queries = []
            for t in p.get("targets", []):
                if t.get("hide"):
                    continue
                q = {
                    "refId": t["refId"],
                    "datasource": {"type": "prometheus", "uid": "prometheus"},
                    "expr": interpolate(t["expr"], pvalues),
                    "range": t.get("range", True),
                    "instant": t.get("instant", False),
                    "format": t.get("format", "time_series"),
                    "legendFormat": t.get("legendFormat", ""),
                    "interval": interpolate(t.get("interval", interval), pvalues),
                    "intervalMs": interval_ms(interpolate(t.get("interval", interval), pvalues)),
                    "maxDataPoints": p.get("maxDataPoints", 1000),
                }
                queries.append(q)
            if not queries:
                continue
            try:
                res = api("/api/ds/query", {"queries": queries, "from": str(frm * 1000), "to": str(to_s * 1000)})
            except urllib.error.HTTPError as e:
                failures.append(f"{dash['uid']} / {p['title']}: HTTP {e.code} {e.read()[:300]!r}")
                continue
            has_data = False
            for ref, r in res["results"].items():
                checked += 1
                if r.get("error"):
                    failures.append(f"{dash['uid']} / {p['title']} [{ref}]: {r['error'][:300]}")
                for f in r.get("frames", []):
                    vals = f.get("data", {}).get("values", [])
                    if vals and any(len(v) for v in vals[1:] or vals):
                        has_data = True
            if not has_data and not MAY_BE_EMPTY.get((dash["uid"], p["title"])):
                failures.append(f"{dash['uid']} / {p['title']}: no data")
    print(f"{len(dashboards)} dashboards, {checked} queries checked")
    for f in failures:
        print("FAIL", f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
