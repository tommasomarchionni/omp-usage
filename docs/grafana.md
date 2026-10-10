# Grafana Dashboard

## Dashboard JSON

Import this JSON in Grafana → Dashboards → Import → Upload JSON file.

```json
{
  "uid": "omp-usage",
  "title": "OMP Usage",
  "tags": ["omp", "llm", "usage"],
  "timezone": "browser",
  "panels": [
    {
      "id": 1,
      "title": "Tokens per Second (by Provider)",
      "type": "timeseries",
      "gridPos": {"x": 0, "y": 0, "w": 12, "h": 8},
      "targets": [
        {
          "expr": "sum by (provider) (rate(omp_llm_tokens_total[5m]))",
          "legendFormat": "{{provider}}",
          "refId": "A"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "ops",
          "custom": {"lineWidth": 2}
        }
      }
    },
    {
      "id": 2,
      "title": "Tokens per Second (by Model)",
      "type": "timeseries",
      "gridPos": {"x": 12, "y": 0, "w": 12, "h": 8},
      "targets": [
        {
          "expr": "sum by (model, direction) (rate(omp_llm_tokens_total[5m]))",
          "legendFormat": "{{model}} - {{direction}}",
          "refId": "A"
        }
      ],
      "fieldConfig": {
        "defaults": {"unit": "ops"}
      }
    },
    {
      "id": 3,
      "title": "Requests per Second (Success vs Error)",
      "type": "timeseries",
      "gridPos": {"x": 0, "y": 8, "w": 12, "h": 8},
      "targets": [
        {
          "expr": "sum by (status) (rate(omp_llm_requests_total[5m]))",
          "legendFormat": "{{status}}",
          "refId": "A"
        }
      ],
      "fieldConfig": {
        "defaults": {"unit": "ops"}
      }
    },
    {
      "id": 4,
      "title": "Error Rate by Provider",
      "type": "timeseries",
      "gridPos": {"x": 12, "y": 8, "w": 12, "h": 8},
      "targets": [
        {
          "expr": "sum by (provider) (rate(omp_llm_requests_total{status=\"error\"}[5m])) / sum by (provider) (rate(omp_llm_requests_total[5m]))",
          "legendFormat": "{{provider}}",
          "refId": "A"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
          "min": 0,
          "max": 1
        }
      }
    },
    {
      "id": 5,
      "title": "Reasoning Tokens per Second",
      "type": "timeseries",
      "gridPos": {"x": 0, "y": 16, "w": 12, "h": 8},
      "targets": [
        {
          "expr": "sum by (provider, model) (rate(omp_llm_reasoning_tokens_total[5m]))",
          "legendFormat": "{{provider}} / {{model}}",
          "refId": "A"
        }
      ],
      "fieldConfig": {
        "defaults": {"unit": "ops"}
      }
    },
    {
      "id": 6,
      "title": "Reported Cost per Hour (USD)",
      "type": "timeseries",
      "gridPos": {"x": 12, "y": 16, "w": 12, "h": 8},
      "targets": [
        {
          "expr": "sum by (provider, model) (rate(omp_llm_reported_cost_usd_total[1h]))",
          "legendFormat": "{{provider}} / {{model}}",
          "refId": "A"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "currencyUSD",
          "min": 0
        }
      }
    },
    {
      "id": 7,
      "title": "Missing Usage Events",
      "type": "timeseries",
      "gridPos": {"x": 0, "y": 24, "w": 12, "h": 8},
      "targets": [
        {
          "expr": "sum by (provider, model) (rate(omp_llm_usage_missing_total[5m]))",
          "legendFormat": "{{provider}} / {{model}}",
          "refId": "A"
        }
      ],
      "fieldConfig": {
        "defaults": {"unit": "ops"}
      }
    },
    {
      "id": 8,
      "title": "Exporter Health",
      "type": "stat",
      "gridPos": {"x": 12, "y": 24, "w": 6, "h": 4},
      "targets": [
        {
          "expr": "omp_usage_last_import_timestamp_seconds",
          "refId": "A"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "thresholds"},
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {"color": "green", "value": null},
              {"color": "red", "value": 300}
            ]
          },
          "mappings": [
            {"type": "value", "options": {"0": {"text": "Never", "color": "red"}}}
          ]
        }
      },
      "options": {
        "textMode": "value",
        "graphMode": "none",
        "justifyMode": "auto"
      }
    },
    {
      "id": 9,
      "title": "Import Errors (5m)",
      "type": "stat",
      "gridPos": {"x": 18, "y": 24, "w": 6, "h": 4},
      "targets": [
        {
          "expr": "increase(omp_usage_import_errors_total[5m])",
          "refId": "A"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "thresholds"},
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 1},
              {"color": "red", "value": 10}
            ]
          }
        }
      },
      "options": {"textMode": "value", "graphMode": "none"}
    },
    {
      "id": 10,
      "title": "Label Cardinality",
      "type": "gauge",
      "gridPos": {"x": 12, "y": 28, "w": 12, "h": 8},
      "targets": [
        {
          "expr": "omp_usage_label_cardinality",
          "refId": "A"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "min": 0,
          "max": 1000,
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 700},
              {"color": "red", "value": 900}
            ]
          },
          "unit": "short"
        }
      }
    }
  ],
  "templating": {
    "list": [
      {
        "name": "provider",
        "type": "query",
        "datasource": {"uid": "prometheus"},
        "query": "label_values(omp_llm_tokens_total, provider)",
        "multi": true,
        "includeAll": true,
        "refresh": 1
      },
      {
        "name": "model",
        "type": "query",
        "datasource": {"uid": "prometheus"},
        "query": "label_values(omp_llm_tokens_total, model)",
        "multi": true,
        "includeAll": true,
        "refresh": 1
      }
    ]
  },
  "time": {
    "from": "now-1h",
    "to": "now"
  },
  "refresh": "30s"
}
```

## Provisioning (Optional)

For automated deployment, save as `dashboards/omp-usage.json` and configure provisioning:

```yaml
# grafana/provisioning/dashboards/omp-usage.yml
apiVersion: 1
providers:
  - name: 'OMP Usage'
    orgId: 1
    folder: 'OMP'
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: /etc/grafana/provisioning/dashboards/omp-usage
```

```yaml
# grafana/provisioning/datasources/prometheus.yml
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
```

## Panel Descriptions

| Panel | Purpose |
|-------|---------|
| Tokens/sec by Provider | Overall throughput per provider |
| Tokens/sec by Model | Breakdown by model and direction |
| Requests/sec | Success vs error rate |
| Error Rate | Percentage of failed requests |
| Reasoning Tokens | Thinking tokens per model |
| Cost/hour | Reported cost trend |
| Missing Usage | Events without usage data |
| Exporter Health | Last import timestamp (green=recent, red=stale) |
| Import Errors | Recent import error count |
| Label Cardinality | Current (provider,model) pair count |

## Variables

The dashboard includes `provider` and `model` variables for filtering. Add panel queries like:
```promql
sum by (direction) (rate(omp_llm_tokens_total{provider=~"$provider", model=~"$model"}[5m]))
```