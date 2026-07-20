"use strict";

const SECRET_KEY_PATTERN = /api[-_]?key|authorization|bearer|token|secret|password|cookie|credential/i;

function secretEnvironmentValues(environment = process.env) {
  return Object.entries(environment)
    .filter(([key, value]) => SECRET_KEY_PATTERN.test(key) && typeof value === "string" && value)
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => right.value.length - left.value.length);
}

function sanitizeDiagnosticText(value, environment = process.env) {
  let sanitized = String(value ?? "");
  for (const { key, value: secret } of secretEnvironmentValues(environment)) {
    sanitized = sanitized.split(secret).join(`[REDACTED:${key}]`);
  }

  return sanitized
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED:API_KEY]")
    .replace(
      /((?:api[-_]?key|token|secret|password|authorization|cookie|credential)\s*[=:]\s*)([^\s,;]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /([?&](?:api[-_]?key|key|token|secret|password|access_token)=)[^&#\s]+/gi,
      "$1[REDACTED]"
    );
}

function sanitizeDiagnosticValue(value, environment = process.env) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item, environment));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY_PATTERN.test(key)
          ? "[REDACTED]"
          : sanitizeDiagnosticValue(item, environment),
      ])
    );
  }
  return typeof value === "string" ? sanitizeDiagnosticText(value, environment) : value;
}

module.exports = {
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
};
