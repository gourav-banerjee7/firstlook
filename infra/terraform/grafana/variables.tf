variable "grafana_url" {
  type    = string
  default = "http://localhost:3000"
}

variable "grafana_auth" {
  description = "Grafana basic auth (user:password) or a service account token."
  type        = string
  default     = "admin:admin"
  sensitive   = true
}

variable "postgres_user" {
  type    = string
  default = "firstlook"
}

variable "postgres_password" {
  type      = string
  default   = "firstlook"
  sensitive = true
}

variable "agent_webhook_url" {
  description = "Where Grafana sends alerts: Firstlook's ingest endpoint."
  type        = string
  default     = "http://agent:8080/webhooks/grafana"
}

variable "agent_webhook_token" {
  description = "Bearer token Grafana sends with each alert; Firstlook rejects alerts without it."
  type        = string
  default     = "dev-webhook-token"
  sensitive   = true
}

variable "latency_p99_seconds" {
  type    = number
  default = 0.8
}

variable "error_rate_ratio" {
  type    = number
  default = 0.05
}

variable "memory_bytes" {
  type    = number
  default = 150000000
}
