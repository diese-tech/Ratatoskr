/** Redaction can also be used by setup commands without loading staff-alert
 * configuration or changing what those commands require to run. */
export function redactOperationalText(value: string): string {
  let result = value;
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && secret.length >= 4 && /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL|SERVICE_ACCOUNT/i.test(name)) {
      result = result.replaceAll(secret, '[REDACTED]');
    }
  }
  try {
    const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '{}').private_key as unknown;
    if (typeof key === 'string' && key.length >= 4)
      for (const representation of [key, JSON.stringify(key).slice(1, -1)]) result = result.replaceAll(representation, '[REDACTED]');
  } catch { /* A malformed credential must not break error reporting. */ }
  return result.replace(/(https?:\/\/|postgres(?:ql)?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(authorization[=: ]+(?:bot|bearer)?\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
