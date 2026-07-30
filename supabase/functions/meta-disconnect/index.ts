// POST { clientId, platform } -- admin/editor only. Deletes the matching
// social_accounts row via service role. Mirrors admin-delete-client's auth
// check pattern (decoded JWT claims, not just verify_jwt).

import { decodeCallerClaims } from "../_shared/jwt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const claims = decodeCallerClaims(req);
  if (!claims || (claims.user_role !== "admin" && claims.user_role !== "editor")) {
    return new Response(JSON.stringify({ error: "not authorized" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { clientId, platform } = await req.json();
  if (!clientId || !platform) {
    return new Response(JSON.stringify({ error: "clientId and platform are required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const res = await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?client_id=eq.${encodeURIComponent(clientId)}&platform=eq.${encodeURIComponent(platform)}`,
    {
      method: "DELETE",
      headers: {
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
      },
    },
  );
  if (!res.ok) {
    return new Response(JSON.stringify({ error: "Failed to disconnect." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
