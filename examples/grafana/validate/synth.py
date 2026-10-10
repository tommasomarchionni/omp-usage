#!/usr/bin/env python3
"""Synthetic OpenMetrics history for validating the dashboards and rules.

    python3 synth.py --days 21 --step 300 > data.om
    promtool tsdb create-blocks-from openmetrics data.om ./tsdb

Series mimic what omp-usage-exporter (job omp_usage, with --pricing-file) and a
llama.cpp server (job llm, --metrics) expose. Usage follows working hours in
Europe/Rome, with lighter weekends. Deterministic (fixed seed).
"""
from __future__ import annotations

import argparse
import math
import random
import sys
import time

OMP = {"job": "omp_usage", "instance": "mac.example:9464", "app": "omp-usage-exporter"}
LLM = {"job": "llm", "instance": "mac.example:8080"}

# provider, model, weight, tokens per request (input, output, cache_read, cache_write),
# reasoning share of output, reported USD per 1M (input, output, cache_read, cache_write) or None
MODELS = [
    ("openrouter", "openrouter/free", 1.0, (11000, 300, 0, 0), 0.4, (0, 0, 0, 0)),
    ("openrouter", "qwen/qwen3.6-35b-a3b:free", 0.8, (9000, 450, 0, 0), 0.3, (0, 0, 0, 0)),
    ("openrouter", "anthropic/claude-sonnet-4.5", 0.5, (2500, 900, 22000, 1800), 0.2, (3, 15, 0.3, 3.75)),
    ("llama.cpp", "qwen3.6-35b-a3b", 1.4, (3000, 600, 14000, 0), 0.35, (0, 0, 0, 0)),
    ("github-copilot", "gpt-5-mini", 0.6, (6000, 500, 4000, 0), 0.25, None),
]

PRICES = {  # what --pricing-file resolves (USD per 1M)
    ("openrouter", "openrouter/free"): ({"input": 0, "output": 0}, "openrouter", "openrouter/free", "auto"),
    ("openrouter", "qwen/qwen3.6-35b-a3b:free"): (
        {"input": 0.15, "output": 1, "cache_read": 0.05}, "openrouter", "qwen/qwen3.6-35b-a3b", "auto"),
    ("openrouter", "anthropic/claude-sonnet-4.5"): (
        {"input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75}, "openrouter",
        "anthropic/claude-sonnet-4.5", "auto"),
    ("llama.cpp", "qwen3.6-35b-a3b"): (
        {"input": 0.15, "output": 1, "cache_read": 0.05}, "openrouter", "qwen/qwen3.6-35b-a3b", "file"),
}
REFERENCES = {
    "anthropic/claude-sonnet-4.5": {"input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75},
    "openai/gpt-5": {"input": 1.25, "output": 10, "cache_read": 0.125},
    "openai/gpt-5-mini": {"input": 0.25, "output": 2, "cache_read": 0.025},
}
DIRECTIONS = ("input", "output", "cache_read", "cache_write")


def activity(ts: float) -> float:
    """Requests per minute multiplier: Rome working hours, lighter weekends."""
    lt = time.gmtime(ts + 2 * 3600)  # CEST
    hour = lt.tm_hour + lt.tm_min / 60
    day = 0.15 + math.exp(-((hour - 11) ** 2) / 6) + 0.8 * math.exp(-((hour - 16) ** 2) / 5)
    day += 0.25 * math.exp(-((hour - 22) ** 2) / 2)  # evening session
    weekend = lt.tm_wday >= 5
    return day * (0.3 if weekend else 1.0)


def labels(d: dict) -> str:
    return "{" + ",".join(f'{k}="{v}"' for k, v in d.items()) + "}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=21)
    ap.add_argument("--step", type=int, default=300, help="seconds between samples")
    ap.add_argument("--end", type=float, default=time.time() - 60)
    args = ap.parse_args()

    rnd = random.Random(42)
    end = int(args.end) // args.step * args.step
    start = end - args.days * 86400
    steps = list(range(start, end + 1, args.step))

    series: dict[tuple[str, str, str], list[tuple[int, float]]] = {}

    def add(family: str, kind: str, name: str, lbl: dict, ts: int, v: float):
        series.setdefault((family, kind, name + labels(lbl)), []).append((ts, v))

    tot = {}
    llm = {"prompt": 0.0, "cached": 0.0, "pred": 0.0, "pred_s": 0.0, "prompt_s": 0.0, "decode": 0.0}
    imported = 0
    invalid = {"invalid_json": 0.0, "invalid_schema": 0.0}
    cpu = 0.0
    for ts in steps:
        act = activity(ts)
        for provider, model, weight, per_req, rshare, price in MODELS:
            key = (provider, model)
            t = tot.setdefault(key, {"tok": [0.0] * 4, "reason": 0.0, "succ": 0.0, "err": 0.0, "abort": 0.0,
                                     "cost": 0.0, "stop": 0.0, "length": 0.0, "tool": 0.0, "costmiss": 0.0})
            n = max(0, int(rnd.gauss(act * weight * args.step / 60 * 0.6, 0.6)))
            for _ in range(n):
                toks = [max(0, int(rnd.gauss(x, x * 0.35))) if x else 0 for x in per_req]
                for i in range(4):
                    t["tok"][i] += toks[i]
                t["reason"] += int(toks[1] * rshare)
                r = rnd.random()
                if r < 0.03:
                    t["err"] += 1
                elif r < 0.04:
                    t["abort"] += 1
                else:
                    t["succ"] += 1
                s = rnd.random()
                if s < 0.55:
                    t["tool"] += 1
                elif s < 0.58:
                    t["length"] += 1
                else:
                    t["stop"] += 1
                if price is None:
                    t["costmiss"] += 1
                else:
                    t["cost"] += sum(toks[i] * price[i] for i in range(4)) / 1e6
                if provider == "llama.cpp":
                    llm["prompt"] += toks[0]
                    llm["cached"] += toks[2]
                    llm["pred"] += toks[1]
                    llm["pred_s"] += toks[1] / rnd.uniform(38, 52)
                    llm["prompt_s"] += toks[0] / rnd.uniform(700, 1100)
                    llm["decode"] += toks[1] + 3
                imported += 1
            base = {**OMP, "provider": provider, "model": model}
            for i, direction in enumerate(DIRECTIONS):
                add("omp_llm_tokens", "counter", "omp_llm_tokens_total", {**base, "direction": direction}, ts, t["tok"][i])
            add("omp_llm_reasoning_tokens", "counter", "omp_llm_reasoning_tokens_total", base, ts, t["reason"])
            for st, k in (("success", "succ"), ("error", "err"), ("aborted", "abort")):
                add("omp_llm_requests", "counter", "omp_llm_requests_total", {**base, "status": st}, ts, t[k])
            for sr, k in (("stop", "stop"), ("toolUse", "tool"), ("length", "length"), ("error", "err")):
                add("omp_llm_stop_reasons", "counter", "omp_llm_stop_reasons_total", {**base, "stop_reason": sr}, ts, t[k])
            add("omp_llm_reported_cost_usd", "counter", "omp_llm_reported_cost_usd_total", base, ts, t["cost"])
            add("omp_llm_cost_missing", "counter", "omp_llm_cost_missing_total", base, ts, t["costmiss"])
            add("omp_llm_usage_missing", "counter", "omp_llm_usage_missing_total", base, ts, 0)
            if key in PRICES:
                table, source, or_id, mapping = PRICES[key]
                for direction, v in table.items():
                    add("omp_llm_price_usd_per_million_tokens", "gauge", "omp_llm_price_usd_per_million_tokens",
                        {**base, "direction": direction, "source": source}, ts, v)
                add("omp_llm_pricing_info", "gauge", "omp_llm_pricing_info",
                    {**base, "openrouter_id": or_id, "mapping": mapping}, ts, len(table))
        for ref, table in REFERENCES.items():
            for direction, v in table.items():
                add("omp_llm_reference_price_usd_per_million_tokens", "gauge",
                    "omp_llm_reference_price_usd_per_million_tokens",
                    {**OMP, "reference_model": ref, "direction": direction, "source": "openrouter"}, ts, v)

        # exporter health
        if rnd.random() < 0.002:
            invalid["invalid_json"] += 1
        g = lambda name, v, extra=None: add(name, "gauge", name, {**OMP, **(extra or {})}, ts, v)  # noqa: E731
        c = lambda name, fam, v, extra=None: add(fam, "counter", name, {**OMP, **(extra or {})}, ts, v)  # noqa: E731
        c("omp_usage_events_imported_total", "omp_usage_events_imported", imported)
        for reason, v in invalid.items():
            c("omp_usage_invalid_records_total", "omp_usage_invalid_records", v, {"reason": reason})
        c("omp_usage_import_errors_total", "omp_usage_import_errors", 0, {"reason": "io"})
        c("omp_usage_file_resets_total", "omp_usage_file_resets", 0, {"reason": "truncated"})
        c("omp_usage_files_deleted_total", "omp_usage_files_deleted", 0)
        g("omp_usage_last_import_timestamp_seconds", ts - rnd.randint(0, 5))
        g("omp_usage_last_import_success", 1)
        g("omp_usage_last_import_duration_seconds", rnd.uniform(0.002, 0.02))
        g("omp_usage_files_tracked", 40 + (ts - start) // 21600)
        g("omp_usage_label_cardinality", len(MODELS))
        g("omp_usage_label_overflow_pairs", 0)
        g("omp_usage_build_info", 1, {"version": "0.3.0", "node_version": "v22.23.3"})
        g("omp_usage_process_resident_memory_bytes", 60e6 + rnd.uniform(0, 8e6))
        g("omp_usage_nodejs_heap_size_used_bytes", 18e6 + rnd.uniform(0, 4e6))
        g("omp_usage_nodejs_eventloop_lag_p99_seconds", rnd.uniform(0.010, 0.013))
        cpu += args.step * rnd.uniform(0.001, 0.004)
        c("omp_usage_process_cpu_seconds_total", "omp_usage_process_cpu_seconds", cpu)
        g("omp_usage_pricing_catalog_models", 458)
        g("omp_usage_pricing_catalog_updated_timestamp_seconds", ts - (ts % 86400))
        g("omp_usage_pricing_unresolved", 1, {"kind": "model", "name": "ollama/my-finetune"})
        c("omp_usage_pricing_errors_total", "omp_usage_pricing_errors", 0, {"kind": "catalog_refresh"})
        add("up", "gauge", "up", {k: OMP[k] for k in ("job", "instance")}, ts, 1)
        add("scrape_duration_seconds", "gauge", "scrape_duration_seconds",
            {k: OMP[k] for k in ("job", "instance")}, ts, rnd.uniform(0.004, 0.012))

        # llama.cpp server
        busy = act > 0.4
        add("llamacpp:prompt_tokens", "counter", "llamacpp:prompt_tokens_total", LLM, ts, llm["prompt"] * 1.15)
        add("llamacpp:prompt_tokens_cached", "counter", "llamacpp:prompt_tokens_cached_total", LLM, ts, llm["cached"])
        add("llamacpp:prompt_seconds", "counter", "llamacpp:prompt_seconds_total", LLM, ts, llm["prompt_s"] * 1.15)
        add("llamacpp:tokens_predicted", "counter", "llamacpp:tokens_predicted_total", LLM, ts, llm["pred"] * 1.2)
        add("llamacpp:tokens_predicted_seconds", "counter", "llamacpp:tokens_predicted_seconds_total", LLM, ts,
            llm["pred_s"] * 1.2)
        add("llamacpp:n_decode", "counter", "llamacpp:n_decode_total", LLM, ts, llm["decode"])
        add("llamacpp:n_tokens_max", "gauge", "llamacpp:n_tokens_max", LLM, ts, 48000)
        add("llamacpp:prompt_tokens_seconds", "gauge", "llamacpp:prompt_tokens_seconds", LLM, ts,
            rnd.uniform(750, 1050) if busy else 0)
        add("llamacpp:predicted_tokens_seconds", "gauge", "llamacpp:predicted_tokens_seconds", LLM, ts,
            rnd.uniform(40, 50) if busy else 0)
        add("llamacpp:requests_processing", "gauge", "llamacpp:requests_processing", LLM, ts,
            rnd.randint(0, 2) if busy else 0)
        add("llamacpp:requests_deferred", "gauge", "llamacpp:requests_deferred", LLM, ts, 0)
        add("llamacpp:n_busy_slots_per_decode", "gauge", "llamacpp:n_busy_slots_per_decode", LLM, ts,
            rnd.uniform(1, 1.3))

    out = sys.stdout
    families: dict[str, list] = {}
    for (family, kind, key), samples in series.items():
        families.setdefault((family, kind), []).append((key, samples))
    for (family, kind), items in families.items():
        out.write(f"# TYPE {family} {kind}\n")
        for key, samples in items:
            for ts, v in samples:
                out.write(f"{key} {v:.10g} {ts}\n")
    out.write("# EOF\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
