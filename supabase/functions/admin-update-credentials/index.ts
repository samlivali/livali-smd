// POST { targetRole: 'admin'|'editor', username, password } -- admin-only.
// Updates the (single) admin or editor account's real Auth credentials via
// the Admin API, replacing the old adminUsernameOverride-style plaintext
// fields entirely.

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

  const { targetRole, username, password } = await req.json();
  if (targetRole !== "admin" && targetRole !== "editor") {
    return new Response(JSON.stringify({ error: "targetRole must be admin or editor" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!username?.trim() || !password) {
    return new Response(JSON.stringify({ error: "Username and password cannot be empty." }), {
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

  const targetRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?role=eq.${targetRole}&select=id`,
    { headers },
  );
  const targets = targetRes.ok ? await targetRes.json() : [];
  if (!targets.length) {
    return new Response(JSON.stringify({ error: `No ${targetRole} account found.` }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const targetId = targets[0].id;

  const takenRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&id=neq.${targetId}&select=id`,
    { headers },
  );
  const taken = takenRes.ok ? await takenRes.json() : [];
  if (taken.length) {
    return new Response(JSON.stringify({ error: "That username is already taken." }), {
      status: 409,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const updateAuthRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${targetId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!updateAuthRes.ok) {
    return new Response(JSON.stringify({ error: "Failed to update login." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const updateProfileRes = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${targetId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ username: username.trim(), email }),
  });
  if (!updateProfileRes.ok) {
    return new Response(JSON.stringify({ error: "Failed to update profile record." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
