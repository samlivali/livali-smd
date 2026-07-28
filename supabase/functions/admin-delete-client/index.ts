// POST { clientId } -- admin-only. Deletes the client's login account(s)
// explicitly via the Admin API (never rely on cascade alone for auth.users,
// since profiles->auth.users cascades but not the reverse) and then the
// clients row itself, which cascades posts/strategy_notes/social_accounts.

import { decodeCallerClaims } from "../_shared/jwt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const claims = decodeCallerClaims(req);
  if (!claims || claims.user_role !== "admin") {
    return new Response(JSON.stringify({ error: "not authorized" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { clientId } = await req.json();
  if (!clientId) {
    return new Response(JSON.stringify({ error: "clientId is required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const headers = {
    "Content-Type": "application/json",
    "apikey": serviceRoleKey,
    "Authorization": `Bearer ${serviceRoleKey}`,
  };

  const profilesRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?client_id=eq.${encodeURIComponent(clientId)}&select=id`,
    { headers },
  );
  const profiles = profilesRes.ok ? await profilesRes.json() : [];
  for (const p of profiles) {
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${p.id}`, { method: "DELETE", headers });
  }

  const deleteClientRes = await fetch(`${supabaseUrl}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`, {
    method: "DELETE",
    headers,
  });
  if (!deleteClientRes.ok) {
    return new Response(JSON.stringify({ error: "Failed to delete client." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
