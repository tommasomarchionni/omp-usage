#!/usr/bin/env python3
"""Generates the Grafana dashboards in ./dashboards from one source of truth.

    python3 examples/grafana/generate.py           # write the JSON files
    python3 examples/grafana/generate.py --check   # fail if they are out of date (CI)

Only the Python standard library is used. Edit this file rather than the JSON,
or export your own copy from Grafana after customising it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent / "dashboards"
TAG = "omp-usage"
DS = {"type": "prometheus", "uid": "${datasource}"}

# --------------------------------------------------------------------------
# PromQL building blocks
# --------------------------------------------------------------------------

SEL = 'job=~"$job", provider=~"$provider", model=~"$model"'
TOK = f"omp_llm_tokens_total{{{SEL}}}"
REQ = f"omp_llm_requests_total{{{SEL}}}"
COST = f"omp_llm_reported_cost_usd_total{{{SEL}}}"
REASON = f"omp_llm_reasoning_tokens_total{{{SEL}}}"
STOP = f"omp_llm_stop_reasons_total{{{SEL}}}"
# `max by` drops the `source` label so the join is one-to-one.
PRICE = 'max by (provider, model, direction) (omp_llm_price_usd_per_million_tokens{job=~"$job"})'
REF_PRICE = (
    "max by (reference_model, direction) "
    '(omp_llm_reference_price_usd_per_million_tokens{job=~"$job", reference_model=~"$reference"})'
)


def tok(extra: str = "") -> str:
    return f"omp_llm_tokens_total{{{SEL}{', ' + extra if extra else ''}}}"


def req(extra: str = "") -> str:
    return f"omp_llm_requests_total{{{SEL}{', ' + extra if extra else ''}}}"


def d(direction: str) -> str:
    """Token counter for one direction."""
    return tok(f'direction="{direction}"')


PROMPT = tok('direction=~"input|cache_read|cache_write"')


def status(name: str) -> str:
    return req(f'status="{name}"')


def stop(reason: str) -> str:
    return f'omp_llm_stop_reasons_total{{{SEL}, stop_reason="{reason}"}}'


def inc(metric: str, w: str = "$__range") -> str:
    return f"increase({metric}[{w}])"


def equivalent(w: str = "$__range", by: str = "provider, model") -> str:
    """Tokens × price / 1e6, by `by` (subset of provider, model)."""
    return (
        f"sum by ({by}) (\n  {inc(TOK, w)}\n  * on (provider, model, direction) group_left\n"
        f"  {PRICE}\n) / 1e6"
    )


def reported(w: str = "$__range", by: str = "provider, model") -> str:
    return f"sum by ({by}) ({inc(COST, w)})"


def effective(w: str = "$__range") -> str:
    """Per model: the reported cost when > 0, otherwise the equivalent cost."""
    return f"(\n  ({reported(w)}) > 0\n)\nor\n(\n  {equivalent(w)}\n)"


def savings(w: str = "$__range") -> str:
    """Per priced model: equivalent cost minus reported cost (unpriced models are left out)."""
    return f"(\n  {equivalent(w)}\n)\n- on (provider, model)\n(\n  {reported(w)}\n  or {equivalent(w)} * 0\n)"


def reference_cost(w: str = "$__range") -> str:
    return (
        f"sum by (reference_model) (\n  sum by (direction) ({inc(TOK, w)})\n"
        f"  * on (direction) group_right\n  {REF_PRICE}\n) / 1e6"
    )


def price_dir(direction: str) -> str:
    return (
        "max by (provider, model) (omp_llm_price_usd_per_million_tokens"
        f'{{job=~"$job", provider=~"$provider", model=~"$model", direction="{direction}"}})'
    )


def or0(expr: str) -> str:
    return f"({expr} or vector(0))"


# --------------------------------------------------------------------------
# Panel helpers
# --------------------------------------------------------------------------


def target(expr, legend="", ref="A", instant=False, fmt="time_series", interval=None, hide=False):
    t = {
        "datasource": DS,
        "editorMode": "code",
        "expr": expr,
        "legendFormat": legend or "__auto",
        "refId": ref,
        "range": not instant,
        "instant": instant,
        "format": fmt,
    }
    if interval:
        t["interval"] = interval
    if hide:
        t["hide"] = True
    return t


def thresholds(*steps):
    """steps: (value or None, color)."""
    return {
        "mode": "absolute",
        "steps": [{"color": c, "value": v} for v, c in steps] or [{"color": "green", "value": None}],
    }


def base(kind, title, w, h, targets, unit=None, desc="", decimals=None, **extra):
    p = {
        "type": kind,
        "title": title,
        "description": desc,
        "datasource": DS,
        "gridPos": {"w": w, "h": h},
        "targets": targets,
        "fieldConfig": {"defaults": {}, "overrides": []},
        "options": {},
    }
    if unit:
        p["fieldConfig"]["defaults"]["unit"] = unit
    if decimals is not None:
        p["fieldConfig"]["defaults"]["decimals"] = decimals
    p.update(extra)
    return p


def stat(title, expr, unit="short", desc="", w=4, h=4, color="blue", thr=None, decimals=None,
         time_from=None, text_mode="value", legend=""):
    p = base("stat", title, w, h, [target(expr, legend, instant=True)], unit, desc, decimals)
    p["fieldConfig"]["defaults"]["color"] = {"mode": "thresholds" if thr else "fixed", "fixedColor": color}
    p["fieldConfig"]["defaults"]["thresholds"] = thr or thresholds((None, color))
    p["options"] = {
        "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
        "colorMode": "value",
        "graphMode": "none",
        "justifyMode": "auto",
        "textMode": text_mode,
        "wideLayout": True,
        "showPercentChange": False,
    }
    if time_from:
        p["timeFrom"] = time_from
        p["hideTimeOverride"] = False
    return p


def timeseries(title, targets, unit="short", desc="", w=12, h=8, bars=False, stack=False,
               interval=None, legend_calcs=("sum",), percent_stack=False, max_dp=None,
               decimals=None, overrides=None, log=False):
    if isinstance(targets, str):
        targets = [target(targets)]
    p = base("timeseries", title, w, h, targets, unit, desc, decimals)
    custom = {
        "drawStyle": "bars" if bars else "line",
        "lineWidth": 1 if bars else 2,
        "fillOpacity": 80 if bars else 10,
        "barAlignment": -1,
        "showPoints": "never",
        "spanNulls": False,
        "gradientMode": "none",
        "stacking": {"mode": "percent" if percent_stack else ("normal" if stack else "none"), "group": "A"},
        "axisSoftMin": 0,
    }
    if log:
        custom["scaleDistribution"] = {"type": "log", "log": 10}
    p["fieldConfig"]["defaults"]["custom"] = custom
    p["fieldConfig"]["defaults"]["color"] = {"mode": "palette-classic"}
    if overrides:
        p["fieldConfig"]["overrides"] = overrides
    p["options"] = {
        "legend": {"displayMode": "table", "placement": "right", "calcs": list(legend_calcs), "showLegend": True},
        "tooltip": {"mode": "multi", "sort": "desc"},
    }
    if interval:
        p["interval"] = interval
    if max_dp:
        p["maxDataPoints"] = max_dp
    return p


def bargauge(title, expr, unit="short", desc="", w=12, h=8, legend="{{model}}", decimals=None,
             time_from=None, orientation="horizontal", targets=None):
    p = base("bargauge", title, w, h, targets or [target(expr, legend, instant=True)], unit, desc, decimals)
    p["fieldConfig"]["defaults"]["color"] = {"mode": "continuous-BlYlRd"}
    p["fieldConfig"]["defaults"]["min"] = 0
    p["options"] = {
        "orientation": orientation,
        "displayMode": "gradient",
        "showUnfilled": True,
        "valueMode": "color",
        "namePlacement": "auto",
        "sizing": "auto",
        "minVizHeight": 16,
        "maxVizHeight": 300,
        "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
    }
    if time_from:
        p["timeFrom"] = time_from
    return p


def pie(title, expr, legend, unit="short", desc="", w=8, h=8):
    p = base("piechart", title, w, h, [target(expr, legend, instant=True)], unit, desc)
    p["fieldConfig"]["defaults"]["color"] = {"mode": "palette-classic"}
    p["options"] = {
        "pieType": "donut",
        "legend": {"displayMode": "table", "placement": "right", "values": ["value", "percent"], "showLegend": True},
        "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
        "tooltip": {"mode": "single"},
        "displayLabels": [],
    }
    return p


def table(title, columns, keys=("provider", "model"), desc="", w=24, h=9, sort=None):
    """columns: list of (header, expr, unit). One instant query per column, merged on `keys`."""
    targets = []
    rename = {}
    overrides = []
    for i, (header, expr, unit) in enumerate(columns):
        ref = chr(ord("A") + i)
        targets.append(target(expr, "", ref=ref, instant=True, fmt="table"))
        col = f"Value #{ref}"
        rename[col] = header
        overrides.append({"matcher": {"id": "byName", "options": header},
                          "properties": [{"id": "unit", "value": unit}]
                          + ([{"id": "decimals", "value": 2}] if unit == "currencyUSD" else [])})
    p = base("table", title, w, h, targets, None, desc)
    p["fieldConfig"]["overrides"] = overrides
    p["fieldConfig"]["defaults"]["custom"] = {"align": "auto", "cellOptions": {"type": "auto"}, "filterable": True}
    excl = {"Time": True, "job": True, "instance": True, "app": True}
    p["transformations"] = [
        {"id": "merge", "options": {}},
        {"id": "organize", "options": {"excludeByName": excl, "indexByName": {}, "renameByName": rename}},
    ]
    p["options"] = {"showHeader": True, "cellHeight": "sm", "footer": {"show": False, "reducer": ["sum"], "fields": ""}}
    if sort:
        p["options"]["sortBy"] = [{"displayName": sort, "desc": True}]
    return p


def text(title, content, w=24, h=4):
    return {"type": "text", "title": title, "gridPos": {"w": w, "h": h},
            "options": {"mode": "markdown", "content": content}}


def row(title, collapsed=False):
    return {"type": "row", "title": title, "collapsed": collapsed, "gridPos": {"w": 24, "h": 1}, "panels": []}


def time_of_day(title, expr, fmt, desc, w=12, h=8, unit="short"):
    """Aggregates hourly buckets by hour of day or weekday (dashboard timezone)."""
    p = base("barchart", title, w, h, [target(expr, "tokens", fmt="table", interval="1h")], unit, desc)
    p["interval"] = "1h"
    p["maxDataPoints"] = 5000
    p["fieldConfig"]["defaults"]["color"] = {"mode": "fixed", "fixedColor": "blue"}
    p["fieldConfig"]["defaults"]["custom"] = {"fillOpacity": 80, "lineWidth": 1, "gradientMode": "hue"}
    p["transformations"] = [
        {"id": "formatTime", "options": {"timeField": "Time", "outputFormat": fmt, "useTimezone": True}},
        {"id": "groupBy", "options": {"fields": {"Time": {"aggregations": [], "operation": "groupby"},
                                                  "Value": {"aggregations": ["sum"], "operation": "aggregate"}}}},
        {"id": "sortBy", "options": {"fields": {}, "sort": [{"field": "Time", "desc": False}]}},
    ]
    p["options"] = {"xField": "Time", "orientation": "vertical", "showValue": "never", "stacking": "none",
                    "barWidth": 0.9, "groupWidth": 0.7, "legend": {"showLegend": False, "displayMode": "list",
                                                                    "placement": "bottom", "calcs": []},
                    "tooltip": {"mode": "single"}, "xTickLabelRotation": 0}
    return p


# --------------------------------------------------------------------------
# Variables
# --------------------------------------------------------------------------


def v_datasource():
    return {"type": "datasource", "name": "datasource", "label": "Data source", "query": "prometheus",
            "current": {"text": "Prometheus", "value": "prometheus"}, "hide": 0, "refresh": 1,
            "regex": "", "options": []}


def v_query(name, label, query, multi=True, include_all=True, default=None, hide=0, sort=1):
    v = {"type": "query", "name": name, "label": label, "datasource": DS,
         "definition": query, "query": {"query": query, "refId": "PrometheusVariableQueryEditor-VariableQuery"},
         "refresh": 2, "multi": multi, "includeAll": include_all, "sort": sort, "hide": hide, "regex": "",
         "options": []}
    if include_all:
        v["allValue"] = ".*"
        v["current"] = {"text": ["All"], "value": ["$__all"]} if multi else {"text": "All", "value": "$__all"}
    if default is not None:
        v["current"] = {"text": default, "value": default}
    return v


def v_job():
    v = v_query("job", "Job", "label_values(omp_usage_build_info, job)", multi=False, include_all=False,
                default="omp_usage")
    return v


def v_provider():
    return v_query("provider", "Provider", 'label_values(omp_llm_tokens_total{job=~"$job"}, provider)')


def v_model():
    return v_query("model", "Model", 'label_values(omp_llm_tokens_total{job=~"$job", provider=~"$provider"}, model)')


def v_bucket(default="1d"):
    values = ["1h", "3h", "6h", "12h", "1d", "7d", "30d"]
    return {"type": "interval", "name": "bucket", "label": "Bucket", "query": ",".join(values),
            "auto": False, "auto_count": 30, "auto_min": "1h", "refresh": 2, "hide": 0,
            "current": {"text": default, "value": default},
            "options": [{"text": x, "value": x, "selected": x == default} for x in values]}


def v_text(name, label, default, desc=""):
    return {"type": "textbox", "name": name, "label": label, "query": default, "description": desc,
            "current": {"text": default, "value": default}, "hide": 0,
            "options": [{"selected": True, "text": default, "value": default}]}


def v_custom(name, label, values, default, multi=False):
    return {"type": "custom", "name": name, "label": label, "query": ",".join(values), "multi": multi,
            "includeAll": False, "hide": 0, "current": {"text": default, "value": default},
            "options": [{"text": x, "value": x, "selected": x == default} for x in values]}


COMMON_VARS = [v_datasource(), v_job(), v_provider(), v_model()]

# --------------------------------------------------------------------------
# Layout and dashboard wrapper
# --------------------------------------------------------------------------


def layout(panels):
    """Flow layout: fills rows of 24 columns left to right."""
    x = y = row_h = 0
    pid = 1
    out = []
    for p in panels:
        w, h = p["gridPos"]["w"], p["gridPos"]["h"]
        if p["type"] == "row" or x + w > 24:
            x, y, row_h = 0, y + row_h, 0
        p["gridPos"] = {"x": x, "y": y, "w": w, "h": h}
        p["id"] = pid
        pid += 1
        out.append(p)
        if p["type"] == "row":
            y += 1
            continue
        x += w
        row_h = max(row_h, h)
    return out


def dashboard(uid, title, desc, panels, variables=None, time_from="now-7d", refresh="1m", extra_tags=()):
    return {
        "uid": f"omp-usage-{uid}",
        "title": f"OMP usage / {title}",
        "description": desc,
        "tags": [TAG, *extra_tags],
        "timezone": "browser",
        "editable": True,
        "graphTooltip": 1,
        "schemaVersion": 41,
        "version": 1,
        "refresh": refresh,
        "time": {"from": time_from, "to": "now"},
        "timepicker": {"refresh_intervals": ["30s", "1m", "5m", "15m", "1h"]},
        "fiscalYearStartMonth": 0,
        "liveNow": False,
        "links": [{"title": "OMP usage", "type": "dashboards", "tags": [TAG], "asDropdown": True,
                   "includeVars": True, "keepTime": True, "icon": "external link"}],
        "annotations": {"list": [{
            "builtIn": 1, "datasource": {"type": "grafana", "uid": "-- Grafana --"}, "enable": True,
            "hide": True, "iconColor": "rgba(0, 211, 255, 1)", "name": "Annotations & Alerts", "type": "dashboard"}]},
        "templating": {"list": variables if variables is not None else COMMON_VARS},
        "panels": layout(panels),
    }


# --------------------------------------------------------------------------
# Dashboards
# --------------------------------------------------------------------------

TOTAL_TOKENS = f"sum({inc(TOK)})"
TOTAL_REQ = f"sum({inc(REQ)})"
CACHE_HIT = f"sum({inc(d('cache_read'))})\n/\nsum({inc(PROMPT)})"
ERROR_RATIO = f"sum({inc(status('error'))})\n/\nsum({inc(REQ)})"
ACTIVE_MODELS = f"count(sum by (provider, model) ({inc(TOK)}) > 0)"

NOTE_INCREASE = (
    "Values are `increase()` over the selected range. Prometheus attributes tokens to the scrape that "
    "first saw them, not to the event time; importing old JSONL files shows up as one jump."
)


def overview():
    p = [
        stat("Tokens", TOTAL_TOKENS, desc="All directions (input, output, cache read, cache write). " + NOTE_INCREASE),
        stat("Requests", TOTAL_REQ, desc="Assistant messages: success + error + aborted"),
        stat("Error rate", ERROR_RATIO, "percentunit", "stopReason=error / all requests", decimals=1,
             thr=thresholds((None, "green"), (0.02, "orange"), (0.1, "red"))),
        stat("Reported cost", f"sum({inc(COST)})", "currencyUSD", "Cost reported by the providers through OMP. Not an invoice.",
             color="orange", decimals=2),
        stat("Effective cost", f"sum({effective()})", "currencyUSD",
             "Reported cost when > 0, otherwise the equivalent cost from --pricing-file. Empty without prices.",
             color="purple", decimals=2),
        stat("Saved vs pay-per-token", f"sum({savings()})", "currencyUSD",
             "Per priced model: equivalent cost minus reported cost, summed. What local and free models saved.",
             color="green", decimals=2),
        stat("Cache hit ratio", CACHE_HIT, "percentunit", "cache_read / (input + cache_read + cache_write)",
             decimals=1, color="green"),
        stat("Reasoning share", f"sum({inc(REASON)}) / sum({inc(d('output'))})",
             "percentunit", "Reasoning tokens / output tokens (reasoning is part of output)", decimals=1),
        stat("Active models", ACTIVE_MODELS, desc="(provider, model) pairs with tokens in the range"),
        stat("Tokens / request", f"{TOTAL_TOKENS}\n/\n{TOTAL_REQ}", decimals=0),
        stat("Exporter up", 'min(up{job=~"$job"})', "bool_on_off", "Prometheus can scrape the exporter",
             thr=thresholds((None, "red"), (1, "green"))),
        stat("Last import", 'time() - max(omp_usage_last_import_timestamp_seconds{job=~"$job"})', "s",
             "Seconds since the last successful import cycle",
             thr=thresholds((None, "green"), (120, "orange"), (600, "red")), decimals=0),
        timeseries("Tokens by model", [target(f"sum by (provider, model) ({inc(TOK, '$__interval')})",
                                              "{{provider}} / {{model}}")],
                   bars=True, stack=True, interval="$bucket", w=16, desc="Tokens per bucket (variable Bucket)"),
        pie("Token share by model", f"sum by (provider, model) ({inc(TOK)})", "{{provider}} / {{model}}"),
        timeseries("Cost per bucket", [
            target(f"sum({inc(COST, '$__interval')})", "reported", "A"),
            target(f"sum({equivalent('$__interval')})", "equivalent (priced usage)", "B"),
        ], "currencyUSD", bars=True, interval="$bucket", w=12,
            desc="Reported cost vs equivalent cost of the priced usage, side by side (never summed)"),
        timeseries("Requests by status", [target(f"sum by (status) ({inc(REQ, '$__interval')})", "{{status}}")],
                   bars=True, stack=True, interval="$bucket", w=12,
                   overrides=[{"matcher": {"id": "byName", "options": "error"},
                               "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}}]},
                              {"matcher": {"id": "byName", "options": "success"},
                               "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "green"}}]}]),
        table("Models in the selected range", [
            ("Tokens", f"sum by (provider, model) ({inc(TOK)})", "short"),
            ("Input", f"sum by (provider, model) ({inc(d('input'))})", "short"),
            ("Output", f"sum by (provider, model) ({inc(d('output'))})", "short"),
            ("Cache read", f"sum by (provider, model) ({inc(d('cache_read'))})", "short"),
            ("Requests", f"sum by (provider, model) ({inc(REQ)})", "short"),
            ("Errors", f"sum by (provider, model) ({inc(status('error'))})", "short"),
            ("Reported $", reported(), "currencyUSD"),
            ("Equivalent $", equivalent(), "currencyUSD"),
        ], sort="Tokens", h=10),
    ]
    return dashboard("overview", "Overview", "Tokens, requests, costs and exporter status at a glance.",
                     p, COMMON_VARS + [v_bucket()])


def tokens():
    p = [
        row("Volume"),
        timeseries("Tokens by direction", [target(f"sum by (direction) ({inc(TOK, '$__interval')})", "{{direction}}")],
                   bars=True, stack=True, interval="$bucket", w=12),
        timeseries("Tokens by model", [target(f"sum by (provider, model) ({inc(TOK, '$__interval')})", "{{provider}} / {{model}}")],
                   bars=True, stack=True, interval="$bucket", w=12),
        timeseries("Token rate (tokens/min)", [target(f"sum by (provider, model) (rate({TOK}[$__rate_interval])) * 60",
                                                     "{{provider}} / {{model}}")],
                   "short", "Live throughput as seen by Prometheus", w=12, legend_calcs=("mean", "max")),
        timeseries("Model share (100% stacked)", [target(f"sum by (provider, model) ({inc(TOK, '$__interval')})",
                                                         "{{provider}} / {{model}}")],
                   "percent", bars=True, percent_stack=True, interval="$bucket", w=12, legend_calcs=()),
        row("Per model and direction"),
        table("Tokens per model and direction (selected range)", [
            ("Input", f"sum by (provider, model) ({inc(d('input'))})", "short"),
            ("Output", f"sum by (provider, model) ({inc(d('output'))})", "short"),
            ("Cache read", f"sum by (provider, model) ({inc(d('cache_read'))})", "short"),
            ("Cache write", f"sum by (provider, model) ({inc(d('cache_write'))})", "short"),
            ("Reasoning", f"sum by (provider, model) ({inc(REASON)})", "short"),
            ("Total", f"sum by (provider, model) ({inc(TOK)})", "short"),
            ("Cache hit", f"sum by (provider, model) ({inc(d('cache_read'))})\n/\nsum by (provider, model) ({inc(PROMPT)})", "percentunit"),
            ("Reasoning share", f"sum by (provider, model) ({inc(REASON)})\n/\nsum by (provider, model) ({inc(d('output'))})", "percentunit"),
        ], sort="Total"),
        bargauge("Top models by tokens", f"topk(15, sum by (provider, model) ({inc(TOK)}))", legend="{{provider}} / {{model}}", w=12, h=10),
        bargauge("Top models by output tokens", f"topk(15, sum by (provider, model) ({inc(d('output'))}))", legend="{{provider}} / {{model}}", w=12, h=10),
        row("Cache and reasoning"),
        timeseries("Cache hit ratio by model", [target(
            f"sum by (provider, model) ({inc(d('cache_read'), '$__interval')})\n/\nsum by (provider, model) ({inc(PROMPT, '$__interval')})",
            "{{provider}} / {{model}}")], "percentunit", "cache_read / all prompt tokens, per bucket", interval="$bucket",
            legend_calcs=("mean",), w=12),
        timeseries("Reasoning share of output by model", [target(
            f"sum by (provider, model) ({inc(REASON, '$__interval')})\n/\nsum by (provider, model) ({inc(d('output'), '$__interval')})",
            "{{provider}} / {{model}}")], "percentunit", interval="$bucket", legend_calcs=("mean",), w=12),
    ]
    return dashboard("tokens", "Tokens", "Token volume by model, direction and bucket; cache and reasoning.",
                     p, COMMON_VARS + [v_bucket()])


def time_patterns():
    hourly = f"sum({inc(TOK, '1h')})"
    p = [
        text("How to read", "Buckets follow the **Bucket** variable (1h to 30d) and the dashboard time range. "
             "Hour-of-day and weekday panels sum hourly buckets of the whole range in the dashboard timezone; "
             "choose a range of a few weeks for stable patterns. Daily buckets are aligned by Prometheus to UTC "
             "midnight.", h=3),
        timeseries("Tokens per bucket by model", [target(f"sum by (provider, model) ({inc(TOK, '$__interval')})",
                                                         "{{provider}} / {{model}}")],
                   bars=True, stack=True, interval="$bucket", w=24, h=9, max_dp=2000),
        timeseries("Requests per bucket by model", [target(f"sum by (provider, model) ({inc(REQ, '$__interval')})",
                                                           "{{provider}} / {{model}}")],
                   bars=True, stack=True, interval="$bucket", w=12),
        timeseries("Reported cost per bucket by model", [target(f"sum by (provider, model) ({inc(COST, '$__interval')})",
                                                                "{{provider}} / {{model}}")],
                   "currencyUSD", bars=True, stack=True, interval="$bucket", w=12),
        time_of_day("Tokens by hour of day", hourly, "HH", "Sum of hourly token increases grouped by hour (00-23)"),
        time_of_day("Tokens by weekday", hourly, "E ddd", "Sum of hourly token increases grouped by ISO weekday (1 = Monday)"),
        time_of_day("Requests by hour of day", f"sum({inc(REQ, '1h')})", "HH", "Requests grouped by hour of day"),
        time_of_day("Reported cost by weekday", f"sum({inc(COST, '1h')})", "E ddd", "Reported cost by weekday", unit="currencyUSD"),
        timeseries("Tokens: this period vs previous", [
            target(f"sum({inc(TOK, '$__interval')})", "current", "A"),
            target(f"sum(increase({TOK}[$__interval] offset $compare))", "previous ($compare earlier)", "B"),
        ], bars=False, interval="$bucket", w=24, desc="Same bucket shifted by the Compare variable"),
    ]
    variables = COMMON_VARS + [v_bucket("1h"), v_custom("compare", "Compare", ["1d", "7d", "30d"], "7d")]
    return dashboard("time", "Time patterns", "Usage per bucket, hour of day, weekday and period over period.",
                     p, variables, time_from="now-30d")


def costs():
    month = "now/M"
    p = [
        stat("Reported cost (range)", f"sum({inc(COST)})", "currencyUSD", color="orange", decimals=2),
        stat("Month to date", f"sum({inc(COST)})", "currencyUSD", "Calendar month so far (panel time override now/M)",
             color="orange", decimals=2, time_from=month),
        stat("Monthly projection", f"sum(rate({COST}[7d])) * 30 * 86400", "currencyUSD",
             "Average spend of the last 7 days × 30 days", color="purple", decimals=2),
        stat("Budget used (month)", f"sum({inc(COST)}) / $budget", "percentunit",
             "Month to date / Budget variable (USD per month)", decimals=1, time_from=month,
             thr=thresholds((None, "green"), (0.75, "orange"), (1, "red"))),
        stat("Cost / request", f"sum({inc(COST)}) / sum({inc(REQ)})", "currencyUSD", decimals=4),
        stat("Cost / 1M tokens", f"sum({inc(COST)}) / sum({inc(TOK)}) * 1e6", "currencyUSD", decimals=3),
        timeseries("Reported cost per bucket by model", [target(f"sum by (provider, model) ({inc(COST, '$__interval')})",
                                                                "{{provider}} / {{model}}")],
                   "currencyUSD", bars=True, stack=True, interval="$bucket", w=16),
        bargauge("Most expensive models", f"topk(10, {reported()})", "currencyUSD", legend="{{provider}} / {{model}}", w=8, decimals=2),
        timeseries("Cumulative cost in the range", [target(
            f"sum({COST}) - on() group_left() (sum({COST} @ start()) or vector(0))", "cumulative")],
            "currencyUSD", "Running total since the start of the range", w=12, legend_calcs=("lastNotNull",)),
        timeseries("Spend rate vs budget", [
            target(f"sum(rate({COST}[1d])) * 30 * 86400", "monthly rate (1d window)", "A"),
            target("$budget + 0 * sum(up{job=~\"$job\"})", "budget", "B"),
        ], "currencyUSD", w=12, legend_calcs=("lastNotNull",),
            overrides=[{"matcher": {"id": "byName", "options": "budget"},
                        "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}},
                                       {"id": "custom.lineStyle", "value": {"fill": "dash", "dash": [10, 10]}}]}]),
        table("Cost per model (selected range)", [
            ("Reported $", reported(), "currencyUSD"),
            ("Requests", f"sum by (provider, model) ({inc(REQ)})", "short"),
            ("$ / request", f"{reported()}\n/\nsum by (provider, model) ({inc(REQ)})", "currencyUSD"),
            ("$ / 1M tokens", f"{reported()}\n/\nsum by (provider, model) ({inc(TOK)}) * 1e6", "currencyUSD"),
            ("Messages without cost", f"sum by (provider, model) ({inc(f'omp_llm_cost_missing_total{{{SEL}}}')})", "short"),
        ], sort="Reported $"),
    ]
    variables = COMMON_VARS + [v_bucket(), v_text("budget", "Budget (USD/month)", "50",
                                                     "Monthly budget used by the gauge and the alert example")]
    return dashboard("costs", "Reported cost", "Cost reported by providers through OMP: totals, budget, projection.",
                     p, variables, time_from="now-30d")


def equivalent_cost():
    def w(direction: str) -> str:
        return tok(f'direction="{direction}", model=~"$whatif_model"')

    whatif = (
        "(\n"
        f"  {or0('sum(' + inc(w('input')) + ')')} * $price_input\n"
        f"+ {or0('sum(' + inc(w('output')) + ')')} * $price_output\n"
        f"+ {or0('sum(' + inc(w('cache_read')) + ')')} * $price_cache_read\n"
        f"+ {or0('sum(' + inc(w('cache_write')) + ')')} * $price_cache_write\n"
        ") / 1e6"
    )
    whatif_ts = whatif.replace("$__range", "$__interval")
    p = [
        text("About", "**Equivalent cost** = tokens × price from `--pricing-file` (explicit prices or the OpenRouter "
             "catalog). It answers: *what would this usage cost on a pay-per-token API?* **Effective cost** uses the "
             "reported cost when it is > 0 and the equivalent cost otherwise, so local and free models are no longer 0. "
             "Prices are current prices applied to the whole range. See docs/pricing.md.", h=3),
        stat("Reported cost", f"sum({inc(COST)})", "currencyUSD", color="orange", decimals=2),
        stat("Equivalent cost (priced usage)", f"sum({equivalent()})", "currencyUSD", color="purple", decimals=2),
        stat("Effective cost", f"sum({effective()})", "currencyUSD", color="blue", decimals=2),
        stat("Saved", f"sum({savings()})", "currencyUSD", "Per priced model: equivalent − reported", color="green",
             decimals=2),
        stat("Priced share of tokens",
             f"sum(\n  {inc(TOK)}\n  and on (provider, model, direction) {PRICE}\n)\n/\n{TOTAL_TOKENS}",
             "percentunit", "Share of tokens that have a price (coverage of the equivalent cost)", decimals=1,
             thr=thresholds((None, "red"), (0.8, "orange"), (0.99, "green"))),
        stat("Unpriced models", f"count(\n  sum by (provider, model) ({inc(TOK)}) > 0\n  unless on (provider, model) {PRICE}\n) or vector(0)",
             desc="Models with tokens but without any price", thr=thresholds((None, "green"), (1, "orange"))),
        timeseries("Effective cost per bucket by model", [target(f"sum by (provider, model) ({effective('$__interval')})",
                                                                 "{{provider}} / {{model}}")],
                   "currencyUSD", bars=True, stack=True, interval="$bucket", w=12),
        timeseries("Savings per bucket", [target(
            f"sum({savings('$__interval')})",
            "saved")], "currencyUSD", bars=True, interval="$bucket", w=12,
            desc="Equivalent cost minus reported cost, per bucket"),
        bargauge("Savings by model", f"topk(15, {savings()})",
                 "currencyUSD", legend="{{provider}} / {{model}}", w=12, decimals=2),
        bargauge("Equivalent cost by model", f"topk(15, {equivalent()})", "currencyUSD", legend="{{provider}} / {{model}}",
                 w=12, decimals=2),
        table("Reported vs equivalent per model", [
            ("Tokens", f"sum by (provider, model) ({inc(TOK)})", "short"),
            ("Reported $", reported(), "currencyUSD"),
            ("Equivalent $", equivalent(), "currencyUSD"),
            ("Effective $", effective(), "currencyUSD"),
            ("Saved $", savings(), "currencyUSD"),
        ], sort="Equivalent $"),
        table("Prices in use (USD per 1M tokens)", [
            ("Input", price_dir('input'), "currencyUSD"),
            ("Output", price_dir('output'), "currencyUSD"),
            ("Cache read", price_dir('cache_read'), "currencyUSD"),
            ("Cache write", price_dir('cache_write'), "currencyUSD"),
        ], desc="From omp_llm_price_usd_per_million_tokens. Empty cells: that direction has no price.", w=12),
        table("Models with tokens but no price", [
            ("Tokens", f"sum by (provider, model) ({inc(TOK)}) > 0 unless on (provider, model) {PRICE}", "short"),
        ], desc="Add them to the pricing file (models[]) to include them in equivalent cost", w=12),
        row("What-if: your own prices"),
        text("What-if", "Type prices in **USD per 1M tokens** in the variables *In*, *Out*, *Cache R*, *Cache W* and choose "
             "the models in *What-if models*. Nothing is stored: try a price before adding it to the pricing file.", h=3),
        stat("What-if cost (range)", whatif, "currencyUSD", w=6, h=6, color="purple", decimals=2),
        timeseries("What-if cost per bucket", [target(whatif_ts, "what-if")], "currencyUSD", bars=True,
                   interval="$bucket", w=18, h=6),
    ]
    variables = COMMON_VARS + [
        v_bucket(),
        v_query("whatif_model", "What-if models", 'label_values(omp_llm_tokens_total{job=~"$job"}, model)'),
        v_text("price_input", "In $/1M", "0.15"),
        v_text("price_output", "Out $/1M", "0.6"),
        v_text("price_cache_read", "Cache R $/1M", "0.015"),
        v_text("price_cache_write", "Cache W $/1M", "0"),
    ]
    return dashboard("equivalent", "Equivalent cost & savings",
                     "What local and free usage would cost at pay-per-token prices; effective cost; what-if prices.",
                     p, variables, time_from="now-30d")


def references():
    ref_v = v_query("reference", "Reference model",
                    'label_values(omp_llm_reference_price_usd_per_million_tokens{job=~"$job"}, reference_model)')
    per_model = (
        "sum by (provider, model) (\n"
        f"  {inc(TOK)}\n  * on (direction) group_left\n"
        '  max by (direction) (omp_llm_reference_price_usd_per_million_tokens{job=~"$job", reference_model="$reference"})\n'
        ") / 1e6"
    )
    rep_panel = bargauge("Usage priced at $reference, by model", per_model, "currencyUSD",
                         legend="{{provider}} / {{model}}", w=12, h=9, decimals=2)
    rep_panel["repeat"] = "reference"
    rep_panel["repeatDirection"] = "h"
    rep_panel["maxPerRow"] = 2
    p = [
        text("About", "Prices **all** selected usage (any provider) at the price of each reference model from the "
             "`references` list of the pricing file. Token counts come from the original models' tokenizers, so this "
             "is an estimate, not a quote.", h=3),
        bargauge("Cost of the selected usage at each reference model", "", "currencyUSD", w=12, h=9, decimals=2,
                 targets=[target(reference_cost(), "{{reference_model}}", instant=True)]),
        bargauge("Compared with what you paid", "", "currencyUSD", w=12, h=9, decimals=2, targets=[
            target(reference_cost(), "{{reference_model}}", "A", instant=True),
            target(f"sum({inc(COST)})", "reported (actual)", "B", instant=True),
            target(f"sum({effective()})", "effective (reported or equivalent)", "C", instant=True),
        ]),
        timeseries("Reference cost per bucket", [target(reference_cost("$__interval"), "{{reference_model}}")],
                   "currencyUSD", bars=False, interval="$bucket", w=24),
        rep_panel,
        table("Reference prices (USD per 1M tokens)", [
            (n, f'max by (reference_model) (omp_llm_reference_price_usd_per_million_tokens{{job=~"$job", reference_model=~"$reference", direction="{d}"}})', "currencyUSD")
            for n, d in [("Input", "input"), ("Output", "output"), ("Cache read", "cache_read"), ("Cache write", "cache_write")]
        ], keys=("reference_model",), w=24, h=7),
    ]
    return dashboard("references", "Reference model comparison",
                     "What the same usage would cost on reference models (Claude, GPT, Qwen, ...).",
                     p, COMMON_VARS + [v_bucket(), ref_v], time_from="now-30d")


def reliability():
    p = [
        stat("Errors", f"sum({inc(status('error'))})", color="red"),
        stat("Aborted", f"sum({inc(status('aborted'))})", color="orange"),
        stat("Error rate", ERROR_RATIO, "percentunit", decimals=1, thr=thresholds((None, "green"), (0.02, "orange"), (0.1, "red"))),
        stat("Truncated (length)", f'sum({inc(stop('length'))})',
             desc="stopReason=length: the response hit the max output tokens", color="yellow"),
        stat("Usage missing", f"sum({inc(f'omp_llm_usage_missing_total{{{SEL}}}')})", desc="Messages without usage (not zero)", color="purple"),
        stat("Cost missing", f"sum({inc(f'omp_llm_cost_missing_total{{{SEL}}}')})", desc="Messages with usage but no reported cost", color="purple"),
        timeseries("Requests by status", [target(f"sum by (status) ({inc(REQ, '$__interval')})", "{{status}}")],
                   bars=True, stack=True, interval="$bucket", w=12),
        timeseries("Error rate by model", [target(
            f"sum by (provider, model) ({inc(status('error'), '$__interval')})\n/\nsum by (provider, model) ({inc(REQ, '$__interval')})",
            "{{provider}} / {{model}}")], "percentunit", interval="$bucket", w=12, legend_calcs=("mean", "max")),
        pie("Stop reasons", f"sum by (stop_reason) ({inc(STOP)})", "{{stop_reason}}", w=8),
        timeseries("Stop reasons over time", [target(f"sum by (stop_reason) ({inc(STOP, '$__interval')})", "{{stop_reason}}")],
                   bars=True, stack=True, interval="$bucket", w=16),
        table("Reliability per model", [
            ("Requests", f"sum by (provider, model) ({inc(REQ)})", "short"),
            ("Errors", f"sum by (provider, model) ({inc(status('error'))})", "short"),
            ("Aborted", f"sum by (provider, model) ({inc(status('aborted'))})", "short"),
            ("Error rate", f"sum by (provider, model) ({inc(status('error'))})\n/\nsum by (provider, model) ({inc(REQ)})", "percentunit"),
            ("Truncated", f'sum by (provider, model) ({inc(stop('length'))})', "short"),
            ("Tool use", f'sum by (provider, model) ({inc(stop('toolUse'))})', "short"),
            ("Usage missing", f"sum by (provider, model) ({inc(f'omp_llm_usage_missing_total{{{SEL}}}')})", "short"),
        ], sort="Errors"),
    ]
    return dashboard("reliability", "Reliability", "Errors, aborts, stop reasons and missing usage per model.",
                     p, COMMON_VARS + [v_bucket("1h")])


def exporter_health():
    J = 'job=~"$job"'
    p = [
        stat("Up", f"min(up{{{J}}})", "bool_on_off", thr=thresholds((None, "red"), (1, "green"))),
        stat("Last import", f"time() - max(omp_usage_last_import_timestamp_seconds{{{J}}})", "s", decimals=0,
             thr=thresholds((None, "green"), (120, "orange"), (600, "red"))),
        stat("Last cycle OK", f"min(omp_usage_last_import_success{{{J}}})", "bool_yes_no", thr=thresholds((None, "red"), (1, "green"))),
        stat("Events stored", f"sum(omp_usage_events_imported_total{{{J}}})"),
        stat("Files tracked", f"sum(omp_usage_files_tracked{{{J}}})"),
        stat("Label overflow", f"sum(omp_usage_label_overflow_pairs{{{J}}})", desc="Pairs folded into _other",
             thr=thresholds((None, "green"), (1, "red"))),
        timeseries("Events imported per minute", [target(f"sum(rate(omp_usage_events_imported_total{{{J}}}[$__rate_interval])) * 60", "events/min")], w=12),
        timeseries("Invalid records by reason", [target(f"sum by (reason) (increase(omp_usage_invalid_records_total{{{J}}}[$__interval]))", "{{reason}}")],
                   bars=True, stack=True, w=12),
        timeseries("Import errors and file resets", [
            target(f"sum by (reason) (increase(omp_usage_import_errors_total{{{J}}}[$__interval]))", "error: {{reason}}", "A"),
            target(f"sum by (reason) (increase(omp_usage_file_resets_total{{{J}}}[$__interval]))", "reset: {{reason}}", "B"),
            target(f"sum(increase(omp_usage_files_deleted_total{{{J}}}[$__interval]))", "files deleted (retention)", "C"),
        ], bars=True, w=12),
        timeseries("Import cycle duration", [target(f"max(omp_usage_last_import_duration_seconds{{{J}}})", "duration")], "s", w=12,
                   legend_calcs=("mean", "max")),
        timeseries("Memory (RSS) and heap", [
            target(f"max(omp_usage_process_resident_memory_bytes{{{J}}})", "rss", "A"),
            target(f"sum(omp_usage_nodejs_heap_size_used_bytes{{{J}}})", "heap used", "B"),
        ], "bytes", w=8, legend_calcs=("lastNotNull", "max")),
        timeseries("CPU", [target(f"sum(rate(omp_usage_process_cpu_seconds_total{{{J}}}[$__rate_interval]))", "cpu")],
                   "percentunit", w=8, legend_calcs=("mean", "max")),
        timeseries("Scrape duration and event loop lag", [
            target(f"max(scrape_duration_seconds{{{J}}})", "scrape", "A"),
            target(f"max(omp_usage_nodejs_eventloop_lag_p99_seconds{{{J}}})", "event loop p99", "B"),
        ], "s", w=8, legend_calcs=("mean", "max")),
        timeseries("Exported (provider, model) pairs", [
            target(f"max(omp_usage_label_cardinality{{{J}}})", "exported", "A"),
            target(f"max(omp_usage_label_overflow_pairs{{{J}}})", "overflow (_other)", "B"),
        ], w=12, legend_calcs=("lastNotNull",)),
        table("Build", [("Instances", f"max by (instance, version, node_version) (omp_usage_build_info{{{J}}})", "short")],
              w=12, h=8),
        row("Pricing (only with --pricing-file)"),
        stat("Catalog age", f"time() - max(omp_usage_pricing_catalog_updated_timestamp_seconds{{{J}}})", "s", decimals=0,
             thr=thresholds((None, "green"), (172800, "orange"), (604800, "red"))),
        stat("Catalog models", f"max(omp_usage_pricing_catalog_models{{{J}}})"),
        stat("Unresolved entries", f"count(omp_usage_pricing_unresolved{{{J}}}) or vector(0)", thr=thresholds((None, "green"), (1, "orange"))),
        stat("Pricing errors (range)", f"sum(increase(omp_usage_pricing_errors_total{{{J}}}[$__range]))", thr=thresholds((None, "green"), (1, "orange"))),
        table("Unresolved pricing entries", [("Unresolved", f"max by (kind, name) (omp_usage_pricing_unresolved{{{J}}})", "short")],
              keys=("kind", "name"), w=8, h=6),
        table("Price mappings", [("Priced directions", f"max by (provider, model, openrouter_id, mapping) (omp_llm_pricing_info{{{J}}})", "short")],
              w=24, h=8),
    ]
    variables = [v_datasource(), v_job()]
    return dashboard("exporter", "Exporter health", "Import freshness, errors, resources, cardinality and pricing status.",
                     p, variables, time_from="now-24h", refresh="30s")


def local_vs_llamacpp():
    L = 'job=~"$llm_job"'
    o = 'job=~"$job", provider=~"$local_provider"'
    p = [
        text("Never add these numbers", "The same generation can appear **twice**: once in OMP (`job=$job`, provider "
             "$local_provider) and once in the llama.cpp server metrics (`job=$llm_job`). Other clients of llama.cpp "
             "(Open WebUI, scripts) are only in llama.cpp. The panels compare the two sources side by side and as "
             "**ratios**, never as sums. llama.cpp metrics have no model label: one server = one model.", h=4),
        row("Side by side (per bucket)"),
        timeseries("Prompt tokens: OMP vs llama.cpp", [
            target(f'sum(increase(omp_llm_tokens_total{{{o}, direction=~"input|cache_write"}}[$__interval]))', "OMP input + cache write", "A"),
            target(f'sum(increase(omp_llm_tokens_total{{{o}, direction="cache_read"}}[$__interval]))', "OMP cache read", "B"),
            target(f'sum(increase({{__name__="llamacpp:prompt_tokens_total", {L}}}[$__interval]))', "llama.cpp prompt (processed)", "C"),
            target(f'sum(increase({{__name__="llamacpp:prompt_tokens_cached_total", {L}}}[$__interval]))', "llama.cpp prompt (cached)", "D"),
        ], bars=False, interval="$bucket", w=12),
        timeseries("Generated tokens: OMP output vs llama.cpp predicted", [
            target(f'sum(increase(omp_llm_tokens_total{{{o}, direction="output"}}[$__interval]))', "OMP output", "A"),
            target(f'sum(increase({{__name__="llamacpp:tokens_predicted_total", {L}}}[$__interval]))', "llama.cpp predicted", "B"),
        ], interval="$bucket", w=12),
        stat("OMP share of llama.cpp generation",
             f'sum(increase(omp_llm_tokens_total{{{o}, direction="output"}}[$__range]))\n/\nsum(increase({{__name__="llamacpp:tokens_predicted_total", {L}}}[$__range]))',
             "percentunit", "Output tokens OMP saw from local providers / tokens llama.cpp generated. < 100%: other clients. "
             "> 100%: provider mapping or counting differences.", w=6, decimals=1),
        stat("llama.cpp prompt cache reuse",
             f'sum(increase({{__name__="llamacpp:prompt_tokens_cached_total", {L}}}[$__range]))\n/\n(sum(increase({{__name__="llamacpp:prompt_tokens_cached_total", {L}}}[$__range])) + sum(increase({{__name__="llamacpp:prompt_tokens_total", {L}}}[$__range])))',
             "percentunit", "Cached / (cached + processed) prompt tokens", w=6, decimals=1, color="green"),
        stat("OMP cache hit (local)",
             f'sum(increase(omp_llm_tokens_total{{{o}, direction="cache_read"}}[$__range]))\n/\nsum(increase(omp_llm_tokens_total{{{o}, direction=~"input|cache_read|cache_write"}}[$__range]))',
             "percentunit", "As reported by OMP for the local providers", w=6, decimals=1, color="green"),
        stat("Avg generation speed",
             f'sum(increase({{__name__="llamacpp:tokens_predicted_total", {L}}}[$__range]))\n/\nsum(increase({{__name__="llamacpp:tokens_predicted_seconds_total", {L}}}[$__range]))',
             "short", "Tokens per second over the range (from counters)", w=6, decimals=1),
        row("llama.cpp server"),
        timeseries("Throughput (tokens/s)", [
            target(f'max({{__name__="llamacpp:predicted_tokens_seconds", {L}}})', "generation (server avg)", "A"),
            target(f'max({{__name__="llamacpp:prompt_tokens_seconds", {L}}})', "prompt processing (server avg)", "B"),
            target(f'sum(rate({{__name__="llamacpp:tokens_predicted_total", {L}}}[$__rate_interval])) / sum(rate({{__name__="llamacpp:tokens_predicted_seconds_total", {L}}}[$__rate_interval]))', "generation (from counters)", "C"),
        ], w=12, legend_calcs=("mean", "max"), log=True),
        timeseries("Slots and queue", [
            target(f'max({{__name__="llamacpp:requests_processing", {L}}})', "processing", "A"),
            target(f'max({{__name__="llamacpp:requests_deferred", {L}}})', "deferred", "B"),
            target(f'max({{__name__="llamacpp:n_busy_slots_per_decode", {L}}})', "busy slots / decode", "C"),
        ], w=12, legend_calcs=("mean", "max")),
        timeseries("Busy time (share of wall clock)", [
            target(f'sum(rate({{__name__="llamacpp:prompt_seconds_total", {L}}}[$__rate_interval]))', "prompt", "A"),
            target(f'sum(rate({{__name__="llamacpp:tokens_predicted_seconds_total", {L}}}[$__rate_interval]))', "generation", "B"),
        ], "percentunit", stack=True, w=12, legend_calcs=("mean",)),
        timeseries("Largest sequence seen (prompt + generation)", [
            target(f'max({{__name__="llamacpp:n_tokens_max", {L}}})', "n_tokens_max")], w=12, legend_calcs=("lastNotNull",)),
        row("OMP view of local models"),
        timeseries("Local tokens by model and direction", [target(
            f"sum by (model, direction) (increase(omp_llm_tokens_total{{{o}}}[$__interval]))", "{{model}} {{direction}}")],
            bars=True, stack=True, interval="$bucket", w=12),
        timeseries("Equivalent cost of local usage", [target(
            "sum by (model) (\n  increase(omp_llm_tokens_total{" + o + "}[$__interval])\n  * on (provider, model, direction) group_left\n  " + PRICE + "\n) / 1e6",
            "{{model}}")], "currencyUSD", bars=True, stack=True, interval="$bucket", w=12,
            desc="Requires prices for the local models in --pricing-file"),
    ]
    variables = [v_datasource(), v_job(),
                 v_query("local_provider", "Local providers", 'label_values(omp_llm_tokens_total{job=~"$job"}, provider)',
                         include_all=False, default="llama.cpp"),
                 v_text("llm_job", "llama.cpp job", "llm", "Prometheus job of the llama.cpp server (--metrics)"),
                 v_bucket("1h")]
    return dashboard("local", "Local models vs llama.cpp",
                     "OMP usage of local providers next to the llama.cpp server metrics, compared without summing.",
                     p, variables, time_from="now-24h")


def efficiency():
    by = "sum by (provider, model)"
    p = [
        timeseries("Tokens per request", [target(f"{by} ({inc(TOK, '$__interval')})\n/\n{by} ({inc(REQ, '$__interval')})",
                                                 "{{provider}} / {{model}}")], interval="$bucket", w=12, legend_calcs=("mean", "max")),
        timeseries("Output tokens per successful request", [target(
            f"{by} ({inc(d('output'), '$__interval')})\n/\n{by} ({inc(status('success'), '$__interval')})",
            "{{provider}} / {{model}}")], interval="$bucket", w=12, legend_calcs=("mean", "max")),
        timeseries("Output / prompt ratio", [target(
            f"{by} ({inc(d('output'), '$__interval')})\n/\n{by} ({inc(PROMPT, '$__interval')})",
            "{{provider}} / {{model}}")], "percentunit", "Generated tokens per prompt token", interval="$bucket", w=12,
            legend_calcs=("mean",)),
        timeseries("Prompt size per request", [target(
            f"{by} ({inc(PROMPT, '$__interval')})\n/\n{by} ({inc(REQ, '$__interval')})",
            "{{provider}} / {{model}}")], "short", "Average context sent per request (input + cache)", interval="$bucket",
            w=12, legend_calcs=("mean", "max")),
        timeseries("Reported $ per 1M tokens", [target(f"{by} ({inc(COST, '$__interval')})\n/\n{by} ({inc(TOK, '$__interval')}) * 1e6",
                                                       "{{provider}} / {{model}}")], "currencyUSD", interval="$bucket",
                   w=12, legend_calcs=("mean",)),
        timeseries("Equivalent $ per 1M tokens", [target(f"{equivalent('$__interval')}\n/\n{by} ({inc(TOK, '$__interval')}) * 1e6",
                                                         "{{provider}} / {{model}}")], "currencyUSD",
                   "Blended price given each model's mix of input/output/cache", interval="$bucket", w=12, legend_calcs=("mean",)),
        table("Efficiency per model (selected range)", [
            ("Tokens / request", f"{by} ({inc(TOK)}) / {by} ({inc(REQ)})", "short"),
            ("Prompt / request", f"{by} ({inc(PROMPT)}) / {by} ({inc(REQ)})", "short"),
            ("Output / request", f"{by} ({inc(d('output'))}) / {by} ({inc(REQ)})", "short"),
            ("Cache hit", f"{by} ({inc(d('cache_read'))}) / {by} ({inc(PROMPT)})", "percentunit"),
            ("Reasoning share", f"{by} ({inc(REASON)}) / {by} ({inc(d('output'))})", "percentunit"),
            ("Reported $/1M", f"{reported()} / {by} ({inc(TOK)}) * 1e6", "currencyUSD"),
            ("Equivalent $/1M", f"{equivalent()} / {by} ({inc(TOK)}) * 1e6", "currencyUSD"),
        ], sort="Tokens / request"),
    ]
    return dashboard("efficiency", "Efficiency", "Tokens per request, context size, cache, reasoning and blended price per model.",
                     p, COMMON_VARS + [v_bucket()], time_from="now-30d")


def model_drilldown():
    single = [v_datasource(), v_job(),
              v_query("provider", "Provider", 'label_values(omp_llm_tokens_total{job=~"$job"}, provider)', multi=False, include_all=False),
              v_query("model", "Model", 'label_values(omp_llm_tokens_total{job=~"$job", provider=~"$provider"}, model)', multi=False, include_all=False),
              v_bucket("1h")]
    p = [
        stat("Tokens", TOTAL_TOKENS),
        stat("Requests", TOTAL_REQ),
        stat("Error rate", ERROR_RATIO, "percentunit", decimals=1, thr=thresholds((None, "green"), (0.02, "orange"), (0.1, "red"))),
        stat("Reported cost", f"sum({inc(COST)})", "currencyUSD", color="orange", decimals=2),
        stat("Equivalent cost", f"sum({equivalent()})", "currencyUSD", color="purple", decimals=2),
        stat("Cache hit", CACHE_HIT, "percentunit", decimals=1, color="green"),
        timeseries("Tokens by direction", [target(f"sum by (direction) ({inc(TOK, '$__interval')})", "{{direction}}")],
                   bars=True, stack=True, interval="$bucket", w=12),
        timeseries("Requests by status", [target(f"sum by (status) ({inc(REQ, '$__interval')})", "{{status}}")],
                   bars=True, stack=True, interval="$bucket", w=12),
        pie("Stop reasons", f"sum by (stop_reason) ({inc(STOP)})", "{{stop_reason}}", w=8),
        time_of_day("Tokens by hour of day", f"sum({inc(TOK, '1h')})", "HH", "Hourly buckets grouped by hour", w=8),
        table("Prices for this model (USD per 1M)", [
            ("Price", 'max by (direction, source) (omp_llm_price_usd_per_million_tokens{job=~"$job", provider="$provider", model="$model"})', "currencyUSD")],
            keys=("direction",), w=8, h=8),
        timeseries("Reported vs equivalent cost", [
            target(f"sum({inc(COST, '$__interval')})", "reported", "A"),
            target(f"sum({equivalent('$__interval')})", "equivalent", "B"),
        ], "currencyUSD", bars=True, interval="$bucket", w=24),
    ]
    return dashboard("model", "Model drilldown", "Everything about one provider/model.", p, single, time_from="now-7d")


DASHBOARDS = {
    "01-overview.json": overview,
    "02-tokens.json": tokens,
    "03-time-patterns.json": time_patterns,
    "04-reported-cost.json": costs,
    "05-equivalent-cost.json": equivalent_cost,
    "06-reference-models.json": references,
    "07-efficiency.json": efficiency,
    "08-reliability.json": reliability,
    "09-model-drilldown.json": model_drilldown,
    "10-local-vs-llamacpp.json": local_vs_llamacpp,
    "11-exporter-health.json": exporter_health,
}


def render(fn) -> str:
    return json.dumps(fn(), indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    check = "--check" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    stale = []
    for name, fn in DASHBOARDS.items():
        content = render(fn)
        path = OUT / name
        if check:
            if not path.exists() or path.read_text() != content:
                stale.append(name)
        else:
            path.write_text(content)
    extra = {p.name for p in OUT.glob("*.json")} - set(DASHBOARDS)
    if check and (stale or extra):
        print("Dashboards out of date, run: python3 examples/grafana/generate.py", file=sys.stderr)
        for n in stale + sorted(extra):
            print(f"  {n}", file=sys.stderr)
        return 1
    if not check:
        print(f"wrote {len(DASHBOARDS)} dashboards to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
