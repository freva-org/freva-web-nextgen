/**
 * What looks like a credential in something the build publishes: configuration values, a
 * portal-style-v1 stylesheet, a portal-template-v1 template. Frontend artifacts are public.
 */
export const CREDENTIAL_PATTERN =
  /(client[_-]?secret|password|passwd|api[_-]?key|secret[_-]?key|private[_-]?key|bearer\s+[A-Za-z0-9._-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i;
