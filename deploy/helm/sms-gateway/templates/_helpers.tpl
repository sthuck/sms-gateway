{{/*
Expand the name of the chart.
*/}}
{{- define "sms-gateway.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "sms-gateway.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "sms-gateway.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "sms-gateway.labels" -}}
helm.sh/chart: {{ include "sms-gateway.chart" . }}
{{ include "sms-gateway.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "sms-gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sms-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "sms-gateway.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end }}

{{- define "sms-gateway.env" -}}
- name: NODE_ENV
  value: {{ .Values.config.NODE_ENV | quote }}
- name: HOST
  value: {{ .Values.config.HOST | quote }}
- name: PORT
  value: {{ .Values.config.PORT | quote }}
- name: LOG_LEVEL
  value: {{ .Values.config.LOG_LEVEL | quote }}
- name: LLM_BASE_URL
  value: {{ .Values.config.LLM_BASE_URL | quote }}
- name: LLM_MODEL
  value: {{ .Values.config.LLM_MODEL | quote }}
- name: QUEUE_SCHEMA
  value: {{ .Values.queue.schema | quote }}
- name: QUEUE_RETRY_LIMIT
  value: {{ .Values.queue.retryLimit | quote }}
- name: QUEUE_RETRY_DELAY_SECONDS
  value: {{ .Values.queue.retryDelaySeconds | quote }}
- name: QUEUE_RETRY_BACKOFF
  value: {{ .Values.queue.retryBackoff | quote }}
- name: QUEUE_RETRY_DELAY_MAX_SECONDS
  value: {{ .Values.queue.retryDelayMaxSeconds | quote }}
- name: QUEUE_POLLING_INTERVAL_SECONDS
  value: {{ .Values.queue.pollingIntervalSeconds | quote }}
- name: QUEUE_LOCAL_CONCURRENCY
  value: {{ .Values.queue.localConcurrency | quote }}
- name: QUEUE_SHUTDOWN_TIMEOUT_MS
  value: {{ .Values.queue.shutdownTimeoutMs | quote }}
- name: QUEUE_METRICS_PORT
  value: {{ .Values.queue.metricsPort | quote }}
- name: QUEUE_METRICS_HOST
  value: {{ .Values.queue.metricsHost | quote }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.databaseSecretName | quote }}
      key: {{ .Values.secrets.databaseSecretKey | quote }}
- name: ENCRYPTION_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.encryptionSecretName | quote }}
      key: {{ .Values.secrets.encryptionSecretKey | quote }}
- name: LLM_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.llmSecretName | quote }}
      key: {{ .Values.secrets.llmSecretKey | quote }}
{{- end }}
