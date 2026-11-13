# Alerts as code. Each rule is a Prometheus query plus a threshold, evaluated every 10 s, and
# every alert goes to Firstlook through one webhook contact point.

locals {
  service = "demo-api"

  # Shared pieces of each rule: query A, threshold C.
  rules = {
    latency = {
      name      = "High P99 latency"
      for       = "30s"
      severity  = "critical"
      query     = "histogram_quantile(0.99, sum by (le, service_name) (rate(http_server_request_duration_seconds_bucket{service_name=\"${local.service}\"}[1m])))"
      threshold = var.latency_p99_seconds
      summary   = "P99 latency on ${local.service} is above ${var.latency_p99_seconds * 1000} ms."
      runbook   = "https://github.com/gourav-banerjee7/firstlook/blob/main/docs/runbooks/high-latency.md"
    }
    errors = {
      name      = "High 5xx error rate"
      for       = "20s"
      severity  = "critical"
      query     = "sum by (service_name) (rate(http_server_request_duration_seconds_count{service_name=\"${local.service}\",http_response_status_code=~\"5..\"}[1m])) / sum by (service_name) (rate(http_server_request_duration_seconds_count{service_name=\"${local.service}\"}[1m]))"
      threshold = var.error_rate_ratio
      summary   = "More than ${var.error_rate_ratio * 100}% of requests to ${local.service} are failing."
      runbook   = "https://github.com/gourav-banerjee7/firstlook/blob/main/docs/runbooks/error-rate.md"
    }
    memory = {
      name      = "Memory near limit"
      for       = "15s"
      severity  = "warning"
      query     = "max by (service_name) (process_memory_usage_bytes{service_name=\"${local.service}\"})"
      threshold = var.memory_bytes
      summary   = "${local.service} memory is above ${var.memory_bytes / 1000000} MB and climbing toward its limit."
      runbook   = "https://github.com/gourav-banerjee7/firstlook/blob/main/docs/runbooks/memory.md"
    }
  }
}

resource "grafana_rule_group" "demo_api" {
  name             = "demo-api"
  folder_uid       = grafana_folder.firstlook.uid
  interval_seconds = 10

  dynamic "rule" {
    for_each = local.rules
    content {
      name           = rule.value.name
      for            = rule.value.for
      condition      = "C"
      no_data_state  = "OK"
      exec_err_state = "OK"
      labels = {
        severity = rule.value.severity
        service  = local.service
        team     = "bookings"
      }
      annotations = {
        summary     = rule.value.summary
        runbook_url = rule.value.runbook
      }

      data {
        ref_id         = "A"
        datasource_uid = grafana_data_source.prometheus.uid
        relative_time_range {
          from = 300
          to   = 0
        }
        model = jsonencode({
          refId   = "A"
          expr    = rule.value.query
          instant = true
        })
      }

      data {
        ref_id         = "C"
        datasource_uid = "__expr__"
        relative_time_range {
          from = 0
          to   = 0
        }
        model = jsonencode({
          refId      = "C"
          type       = "threshold"
          expression = "A"
          conditions = [{ evaluator = { type = "gt", params = [rule.value.threshold] } }]
        })
      }
    }
  }
}

resource "grafana_contact_point" "firstlook" {
  name = "Firstlook"
  webhook {
    url                       = var.agent_webhook_url
    http_method               = "POST"
    authorization_scheme      = "Bearer"
    authorization_credentials = var.agent_webhook_token
  }
}

resource "grafana_notification_policy" "root" {
  contact_point   = grafana_contact_point.firstlook.name
  group_by        = ["alertname", "service"]
  group_wait      = "5s"
  group_interval  = "30s"
  repeat_interval = "1h"
}
