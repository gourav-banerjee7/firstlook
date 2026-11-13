# Grafana, configured as code: data sources, the service dashboard, alert rules, and the
# webhook that wakes Firstlook. Applied automatically by the `grafana-config` compose service.

terraform {
  required_version = ">= 1.6"
  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.25"
    }
  }
}

provider "grafana" {
  url  = var.grafana_url
  auth = var.grafana_auth
}

# ---- Data sources ----------------------------------------------------------------------------

resource "grafana_data_source" "prometheus" {
  name       = "Prometheus"
  uid        = "prometheus"
  type       = "prometheus"
  url        = "http://prometheus:9090"
  is_default = true
  json_data_encoded = jsonencode({
    httpMethod   = "POST"
    timeInterval = "5s"
  })
}

resource "grafana_data_source" "loki" {
  name = "Loki"
  uid  = "loki"
  type = "loki"
  url  = "http://loki:3100"
  json_data_encoded = jsonencode({
    derivedFields = [{
      name          = "TraceID"
      matcherType   = "label"
      matcherRegex  = "trace_id"
      datasourceUid = "tempo"
      url           = "$${__value.raw}"
    }]
  })
}

resource "grafana_data_source" "tempo" {
  name = "Tempo"
  uid  = "tempo"
  type = "tempo"
  url  = "http://tempo:3200"
  json_data_encoded = jsonencode({
    tracesToLogsV2 = {
      datasourceUid      = "loki"
      spanStartTimeShift = "-1m"
      spanEndTimeShift   = "1m"
      filterByTraceID    = true
      customQuery        = false
    }
    serviceMap = { datasourceUid = "prometheus" }
  })
}

# Deploy markers on the dashboard come straight from the deploy log.
resource "grafana_data_source" "deploys" {
  name     = "Deploy log"
  uid      = "deploys"
  type     = "grafana-postgresql-datasource"
  url      = "postgres:5432"
  username = var.postgres_user
  json_data_encoded = jsonencode({
    database        = "demo"
    sslmode         = "disable"
    postgresVersion = 1600
  })
  secure_json_data_encoded = jsonencode({
    password = var.postgres_password
  })
}

# ---- Dashboard -------------------------------------------------------------------------------

resource "grafana_folder" "firstlook" {
  title = "Firstlook demo"
  uid   = "firstlook"
}

resource "grafana_dashboard" "demo_api" {
  folder      = grafana_folder.firstlook.uid
  config_json = file("${path.module}/dashboards/demo-api.json")
  overwrite   = true
}
