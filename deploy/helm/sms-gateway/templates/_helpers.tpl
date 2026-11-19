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
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.databaseSecretName | quote }}
      key: {{ .Values.secrets.databaseSecretKey | quote }}
- name: ENCRYPTION_ENABLED
  value: {{ .Values.config.ENCRYPTION_ENABLED | quote }}
- name: KEK_ID
  value: {{ .Values.config.KEK_ID | quote }}
- name: KEK_FILE
  value: {{ .Values.config.KEK_FILE | quote }}
- name: KEK_PREVIOUS
  value: {{ .Values.config.KEK_PREVIOUS | quote }}
- name: DEK_CACHE_TTL_MS
  value: {{ .Values.config.DEK_CACHE_TTL_MS | quote }}
- name: DEK_CACHE_MAX_ENTRIES
  value: {{ .Values.config.DEK_CACHE_MAX_ENTRIES | quote }}
- name: LLM_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.llmSecretName | quote }}
      key: {{ .Values.secrets.llmSecretKey | quote }}
{{- if .Values.secrets.oidcEnabled }}
- name: OIDC_ISSUER_URL
  value: {{ .Values.config.OIDC_ISSUER_URL | quote }}
- name: OIDC_CLIENT_ID
  value: {{ .Values.config.OIDC_CLIENT_ID | quote }}
- name: OIDC_REDIRECT_URI
  value: {{ .Values.config.OIDC_REDIRECT_URI | quote }}
- name: OIDC_SCOPES
  value: {{ .Values.config.OIDC_SCOPES | quote }}
- name: OIDC_CLAIM_EMAIL
  value: {{ .Values.config.OIDC_CLAIM_EMAIL | quote }}
- name: OIDC_CLAIM_NAME
  value: {{ .Values.config.OIDC_CLAIM_NAME | quote }}
- name: OIDC_AUDIENCE
  value: {{ .Values.config.OIDC_AUDIENCE | quote }}
- name: OIDC_ALLOWED_ALGS
  value: {{ .Values.config.OIDC_ALLOWED_ALGS | quote }}
- name: REQUIRE_MFA
  value: {{ .Values.config.REQUIRE_MFA | quote }}
- name: MFA_CLAIMS_MISSING
  value: {{ .Values.config.MFA_CLAIMS_MISSING | quote }}
- name: AUTO_LINK_BY_EMAIL
  value: {{ .Values.config.AUTO_LINK_BY_EMAIL | quote }}
- name: PUBLIC_BASE_URL
  value: {{ .Values.config.PUBLIC_BASE_URL | quote }}
- name: CORS_ALLOWED_ORIGINS
  value: {{ .Values.config.CORS_ALLOWED_ORIGINS | quote }}
- name: SESSION_COOKIE_NAME
  value: {{ .Values.config.SESSION_COOKIE_NAME | quote }}
- name: CSRF_COOKIE_NAME
  value: {{ .Values.config.CSRF_COOKIE_NAME | quote }}
- name: SESSION_TTL_SECONDS
  value: {{ .Values.config.SESSION_TTL_SECONDS | quote }}
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
{{- end }}

{{- define "sms-gateway.kekVolume" -}}
- name: kek
  secret:
    secretName: {{ .Values.secrets.encryptionKekSecretName | quote }}
    items:
      - key: {{ .Values.secrets.encryptionKekSecretKey | quote }}
        path: kek
{{- end }}

{{- define "sms-gateway.kekVolumeMount" -}}
- name: kek
  mountPath: /var/run/secrets/sms-gateway
  readOnly: true
{{- end }}
