// POST { clientName, username, password } -- admin-only. Creates a real
// Auth user (Admin API, service_role) for the new client login instead of
// storing a plaintext password field, then the clients + profiles rows.
// Deployed with the default verify_jwt=true (Supabase checks the JWT
// signature before this even runs); we still decode it ourselves to check
// the caller is actually admin, since verify_jwt alone doesn't know about
// our custom role claim.

import { decodeCallerClaims } from "../_shared/jwt.ts";

const EMAIL_DOMAIN = "livali-internal.invalid";
const USERNAME_RE = /^[a-z0-9._-]+$/;

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

  const { clientName, username, password } = await req.json();
  if (!clientName?.trim() || !username?.trim() || !password) {
    return new Response(JSON.stringify({ error: "clientName, username and password are required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const usernameLower = username.trim().toLowerCase();
  if (!USERNAME_RE.test(usernameLower)) {
    return new Response(
      JSON.stringify({ error: "Username can only contain letters, numbers, dots, underscores and hyphens." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const email = `${usernameLower}@${EMAIL_DOMAIN}`;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const headers = {
    "Content-Type": "application/json",
    "apikey": serviceRoleKey,
    "Authorization": `Bearer ${serviceRoleKey}`,
  };

  const existingRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id`,
    { headers },
  );
  const existing = existingRes.ok ? await existingRes.json() : [];
  if (existing.length) {
    return new Response(JSON.stringify({ error: "That username is already taken." }), {
      status: 409,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const clientId = "c" + Date.now() + Math.random().toString(36).slice(2, 5);

  const clientRes = await fetch(`${supabaseUrl}/rest/v1/clients`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: clientId, name: clientName.trim() }),
  });
  if (!clientRes.ok) {
    return new Response(JSON.stringify({ error: "Failed to create client record." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const authUser = await authRes.json();
  if (!authRes.ok) {
    await fetch(`${supabaseUrl}/rest/v1/clients?id=eq.${clientId}`, { method: "DELETE", headers });
    return new Response(JSON.stringify({ error: "Failed to create login." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const profileRes = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: authUser.id,
      role: "client",
      client_id: clientId,
      username: username.trim(),
      email,
    }),
  });
  if (!profileRes.ok) {
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${authUser.id}`, { method: "DELETE", headers });
    await fetch(`${supabaseUrl}/rest/v1/clients?id=eq.${clientId}`, { method: "DELETE", headers });
    return new Response(JSON.stringify({ error: "Failed to create profile." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ id: clientId, name: clientName.trim() }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
