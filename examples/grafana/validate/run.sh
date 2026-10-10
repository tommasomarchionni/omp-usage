#!/usr/bin/env bash
# End-to-end check of the dashboards and Prometheus rules:
# synthetic data -> promtool backfill -> Prometheus (+ recording rules) ->
# Grafana with the example provisioning -> every panel query.
#
#   PROMETHEUS_DIR=/path/to/prometheus-3.x.linux-amd64 \
#   GRAFANA_IMAGE=grafana/grafana:13.2.3 examples/grafana/validate/run.sh
#
# Set GRAFANA_HOME to a Grafana tarball directory to run it without Docker.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PROMETHEUS_DIR=${PROMETHEUS_DIR:?set PROMETHEUS_DIR to an extracted Prometheus release}
GRAFANA_IMAGE=${GRAFANA_IMAGE:-grafana/grafana:13.2.3}
WORK=$(mktemp -d)
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  docker rm -f omp-usage-grafana-check >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== synthetic data"
python3 "$ROOT/examples/grafana/validate/synth.py" --days 21 --step 300 >"$WORK/data.om"
TO=$(awk '/^up\{/{t=$NF} END{print t}' "$WORK/data.om")
"$PROMETHEUS_DIR/promtool" tsdb create-blocks-from openmetrics "$WORK/data.om" "$WORK/tsdb" >/dev/null

echo "== prometheus"
cat >"$WORK/prometheus.yml" <<YAML
global: { evaluation_interval: 1m }
rule_files: ["$ROOT/examples/prometheus/rules/omp-usage.rules.yml"]
YAML
"$PROMETHEUS_DIR/prometheus" --config.file="$WORK/prometheus.yml" --storage.tsdb.path="$WORK/tsdb" \
  --storage.tsdb.retention.time=1y --web.listen-address=127.0.0.1:9090 >"$WORK/prometheus.log" 2>&1 &
PIDS+=($!)

echo "== grafana"
mkdir -p "$WORK/prov/datasources" "$WORK/prov/dashboards" "$WORK/prov/plugins" "$WORK/prov/alerting"
sed 's#http://prometheus:9090#http://127.0.0.1:9090#; s#timeInterval: 30s#timeInterval: 5m#' \
  "$ROOT/examples/grafana/provisioning/datasources/prometheus.yml" >"$WORK/prov/datasources/prometheus.yml"
if [[ -n "${GRAFANA_HOME:-}" ]]; then
  sed "s#/var/lib/grafana/dashboards/omp-usage#$ROOT/examples/grafana/dashboards#" \
    "$ROOT/examples/grafana/provisioning/dashboards/omp-usage.yml" >"$WORK/prov/dashboards/omp-usage.yml"
  GF_PATHS_PROVISIONING="$WORK/prov" GF_PATHS_DATA="$WORK/gdata" GF_SERVER_HTTP_ADDR=127.0.0.1 \
    GF_SECURITY_ADMIN_PASSWORD=admin GF_ANALYTICS_REPORTING_ENABLED=false \
    "$GRAFANA_HOME/bin/grafana" server --homepath "$GRAFANA_HOME" >"$WORK/grafana.log" 2>&1 &
  PIDS+=($!)
else
  cp "$ROOT/examples/grafana/provisioning/dashboards/omp-usage.yml" "$WORK/prov/dashboards/"
  docker run -d --name omp-usage-grafana-check --network host \
    -e GF_SERVER_HTTP_ADDR=127.0.0.1 -e GF_SECURITY_ADMIN_PASSWORD=admin -e GF_ANALYTICS_REPORTING_ENABLED=false \
    -v "$WORK/prov:/etc/grafana/provisioning:ro" \
    -v "$ROOT/examples/grafana/dashboards:/var/lib/grafana/dashboards/omp-usage:ro" \
    "$GRAFANA_IMAGE" >/dev/null
fi

for _ in $(seq 1 90); do
  curl -sf http://127.0.0.1:9090/-/ready >/dev/null && curl -sf http://127.0.0.1:3000/api/health >/dev/null && break
  sleep 2
done
# wait for provisioning
for _ in $(seq 1 30); do
  n=$(curl -sf -u admin:admin 'http://127.0.0.1:3000/api/search?tag=omp-usage' | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))' || echo 0)
  [[ "$n" -ge 11 ]] && break
  sleep 2
done

echo "== panels"
GRAFANA_URL=http://127.0.0.1:3000 python3 "$ROOT/examples/grafana/validate/check_panels.py" --to "$TO"
