{{- define "firstlook.labels" -}}
app.kubernetes.io/part-of: firstlook
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "firstlook.selector" -}}
app.kubernetes.io/name: {{ . }}
{{- end }}

{{- define "firstlook.image" -}}
{{ $.root.Values.image.registry }}/firstlook-{{ $.app }}:{{ $.root.Values.image.tag | default $.root.Chart.AppVersion }}
{{- end }}

{{- define "firstlook.secretName" -}}
{{ .Values.secrets.existingSecret | default (printf "%s-firstlook" .Release.Name) }}
{{- end }}

{{/* Pod-level hardening: never root, no service account token, default seccomp. */}}
{{- define "firstlook.podSecurity" -}}
automountServiceAccountToken: false
securityContext:
  runAsNonRoot: true
  runAsUser: {{ .uid }}
  runAsGroup: {{ .uid }}
  fsGroup: {{ .uid }}
  seccompProfile:
    type: RuntimeDefault
{{- end }}

{{/* Container-level hardening: read-only root filesystem, no privilege escalation, no capabilities. */}}
{{- define "firstlook.containerSecurity" -}}
securityContext:
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: [ALL]
{{- end }}

{{- define "firstlook.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ include "firstlook.secretName" .root }}
      key: {{ .key }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end }}

{{- define "firstlook.otlp" -}}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.observability.otlpEndpoint | quote }}
{{- end }}

{{- /* Explicit value, else the value from the previous install, else a new random one. */}}
{{- define "firstlook.keep" -}}
{{- if .value -}}{{ .value | b64enc }}{{- else if hasKey .old .key -}}{{ index .old .key }}{{- else -}}{{ randAlphaNum 32 | b64enc }}{{- end -}}
{{- end }}
