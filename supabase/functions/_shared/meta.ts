// Shared constants + signed-state helpers for the Meta OAuth Edge Functions.
// State signing uses META_APP_SECRET as the HMAC key purely so we don't need
// a second secret — it never leaves these functions.

export const GRAPH_VERSION = "v21.0";
export const OAUTH_CALLBACK_URL =
  "https://adccekhhqeprxbwcentk.supabase.co/functions/v1/meta-oauth-callback";
// Where we bounce the browser back to once the connection is done.
export const APP_RETURN_URL = "https://samlivali.github.io/livali-smd/";

export const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "business_management",
].join(",");

function toBase64Url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    s.length + ((4 - (s.length % 4)) % 4),
    "=",
  );
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export interface StatePayload {
  clientId: string;
  nonce: string;
  ts: number;
}

// state = base64url(json payload) + "." + base64url(hmac signature)
export async function signState(
  payload: Omit<StatePayload, "ts">,
  secret: string,
): Promise<string> {
  const full: StatePayload = { ...payload, ts: Date.now() };
  const json = JSON.stringify(full);
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(json),
  );
  return `${toBase64Url(new TextEncoder().encode(json))}.${
    toBase64Url(new Uint8Array(sig))
  }`;
}

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes to complete the OAuth dance

// Returns the payload if the signature is valid and not expired, else null.
export async function verifyState(
  state: string,
  secret: string,
): Promise<StatePayload | null> {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(sigB64),
      fromBase64Url(payloadB64),
    );
    if (!ok) return null;
    const json = new TextDecoder().decode(fromBase64Url(payloadB64));
    const payload = JSON.parse(json) as StatePayload;
    if (Date.now() - payload.ts > STATE_MAX_AGE_MS) return null;
    return payload;
  } catch {
    return null;
  }
}
