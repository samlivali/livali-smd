// Decodes (not verifies -- Supabase's gateway already verified the
// signature before invoking the function, since these are deployed with
// verify_jwt=true) the caller's JWT claims from the Authorization header.

export interface CallerClaims {
  sub: string;
  user_role?: "admin" | "editor" | "client";
  client_id?: string;
}

export function decodeCallerClaims(req: Request): CallerClaims | null {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadB64.padEnd(
      payloadB64.length + ((4 - (payloadB64.length % 4)) % 4),
      "=",
    );
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}
