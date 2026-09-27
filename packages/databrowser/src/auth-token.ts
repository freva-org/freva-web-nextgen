// auth-token.ts - the bearer-token supplier contract, shared by the full browser and the picker.
// Kept dependency-free so the picker's import graph stays small.

/** A bearer-token supplier: synchronous, or async so the host's OIDC client can refresh first. */
export type AuthTokenSupplier = () =>
  | string
  | null
  | undefined
  | PromiseLike<string | null | undefined>;

/** Resolve a supplier to a token, treating a throw/rejection as "no token" for this request. */
export async function resolveAuthToken(
  supplier: AuthTokenSupplier | undefined,
): Promise<string | null> {
  if (!supplier) return null;
  try {
    return (await supplier()) || null;
  } catch {
    return null;
  }
}
