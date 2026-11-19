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

{{- define "sms-gateway.encryptionEnabled" -}}
{{- if ne (toString .Values.config.ENCRYPTION_ENABLED) "false" }}true{{- end }}
{{- end }}

{{- define "sms-gateway.apiSecretEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.databaseSecretName | quote }}
      key: {{ .Values.secrets.databaseSecretKey | quote }}
{{- if .Values.secrets.llmEnabled }}
- name: LLM_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.llmSecretName | quote }}
      key: {{ .Values.secrets.llmSecretKey | quote }}
{{- end }}
{{- if .Values.secrets.oidcEnabled }}
- name: OIDC_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.oidcSecretName | quote }}
      key: {{ .Values.secrets.oidcClientSecretKey | quote }}
- name: SESSION_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.oidcSecretName | quote }}
      key: {{ .Values.secrets.sessionSecretKey | quote }}
{{- end }}
{{- if .Values.secrets.cfAccessEnabled }}
- name: CF_ACCESS_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.cfAccessSecretName | quote }}
      key: {{ .Values.secrets.cfAccessClientIdKey | quote }}
      optional: true
- name: CF_ACCESS_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.cfAccessSecretName | quote }}
      key: {{ .Values.secrets.cfAccessClientSecretKey | quote }}
      optional: true
- name: DEVICE_CF_ACCESS_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.cfAccessSecretName | quote }}
      key: {{ .Values.secrets.deviceCfAccessClientIdKey | quote }}
      optional: true
- name: DEVICE_CF_ACCESS_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.cfAccessSecretName | quote }}
      key: {{ .Values.secrets.deviceCfAccessClientSecretKey | quote }}
      optional: true
- name: AGENT_CF_ACCESS_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.cfAccessSecretName | quote }}
      key: {{ .Values.secrets.agentCfAccessClientIdKey | quote }}
      optional: true
- name: AGENT_CF_ACCESS_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.cfAccessSecretName | quote }}
      key: {{ .Values.secrets.agentCfAccessClientSecretKey | quote }}
      optional: true
{{- end }}
{{- end }}

{{- define "sms-gateway.workerSecretEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.databaseSecretName | quote }}
      key: {{ .Values.secrets.databaseSecretKey | quote }}
{{- if .Values.secrets.llmEnabled }}
- name: LLM_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.llmSecretName | quote }}
      key: {{ .Values.secrets.llmSecretKey | quote }}
{{- end }}
{{- end }}

{{- define "sms-gateway.kekVolume" -}}
- name: kek
  secret:
    secretName: {{ .Values.secrets.encryptionKekSecretName | quote }}
    defaultMode: 288 # 0440 octal (YAML 1.2 parses unquoted 0440 as decimal)
{{- end }}

{{- define "sms-gateway.kekVolumeMount" -}}
- name: kek
  mountPath: /var/run/secrets/sms-gateway
  readOnly: true
{{- end }}
