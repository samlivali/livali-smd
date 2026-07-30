// GET /meta-oauth-start?clientId=xxx
// Builds a signed `state` and returns the Meta OAuth dialog URL for the
// frontend to navigate to. Deployed with verify_jwt=true (the default) so
// Supabase rejects missing/invalid tokens before this even runs; we still
// decode the claims ourselves to enforce that a client-role caller can
// only request their own clientId -- verify_jwt alone doesn't know about
// our custom role claim, and previously this endpoint had no caller check
// at all, letting anyone hijack any client's connection slot.
//
// Returns { url } as JSON rather than a 302: a plain <a href> redirect
// can't carry an Authorization header, so the frontend now does
// fetch() + window.location.href itself.

import {
  GRAPH_VERSION,
  OAUTH_CALLBACK_URL,
  signState,
} from "../_shared/meta.ts";
import { decodeCallerClaims } from "../_shared/jwt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const claims = decodeCallerClaims(req);
  if (!claims || !claims.user_role) {
    return new Response(JSON.stringify({ error: "not authorized" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const clientId = url.searchParams.get("clientId");
  if (!clientId) {
    return new Response(JSON.stringify({ error: "Missing clientId query param" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (claims.user_role === "client" && claims.client_id !== clientId) {
    return new Response(JSON.stringify({ error: "not authorized for this client" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (claims.user_role !== "admin" && claims.user_role !== "editor" && claims.user_role !== "client") {
    return new Response(JSON.stringify({ error: "not authorized" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const appId = Deno.env.get("META_APP_ID");
  const appSecret = Deno.env.get("META_APP_SECRET");
  const configId = Deno.env.get("META_LOGIN_CONFIG_ID");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!appId || !appSecret || !configId || !supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: "Server is not configured with META_APP_ID/META_APP_SECRET/META_LOGIN_CONFIG_ID" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const clientRes = await fetch(
    `${supabaseUrl}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&select=id`,
    {
      headers: {
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
      },
    },
  );
  const clientRows = clientRes.ok ? await clientRes.json() : [];
  if (!clientRows.length) {
    return new Response(JSON.stringify({ error: "Unknown clientId" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const state = await signState(
    { clientId, nonce: crypto.randomUUID() },
    appSecret,
  );

  // Facebook Login for Business (Business-type apps) takes a config_id from
  // a saved Login Configuration instead of a raw `scope` list — passing
  // `scope` here 404s with a vague "This content isn't available" error.
  const dialogUrl = new URL(
    `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`,
  );
  dialogUrl.searchParams.set("client_id", appId);
  dialogUrl.searchParams.set("redirect_uri", OAUTH_CALLBACK_URL);
  dialogUrl.searchParams.set("state", state);
  dialogUrl.searchParams.set("config_id", configId);
  dialogUrl.searchParams.set("response_type", "code");

  return new Response(JSON.stringify({ url: dialogUrl.toString() }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
