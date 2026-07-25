// GET /meta-oauth-callback?code=...&state=...
// Meta redirects here after the user approves the OAuth dialog. This
// function exchanges the code for a long-lived Page access token, finds any
// Instagram Business Account linked to that Page, and stores both in
// social_accounts (service_role only — see the migration for why). Finally
// it bounces the browser back to the app.

import {
  APP_RETURN_URL,
  GRAPH_VERSION,
  OAUTH_CALLBACK_URL,
  verifyState,
} from "../_shared/meta.ts";

function backToApp(status: string, detail?: string): Response {
  const u = new URL(APP_RETURN_URL);
  u.searchParams.set("meta_connect", status);
  if (detail) u.searchParams.set("meta_detail", detail);
  return Response.redirect(u.toString(), 302);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error_message");

  if (oauthError) return backToApp("error", oauthError);
  if (!code || !state) return backToApp("error", "missing_code_or_state");

  const appId = Deno.env.get("META_APP_ID");
  const appSecret = Deno.env.get("META_APP_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!appId || !appSecret || !supabaseUrl || !serviceRoleKey) {
    return backToApp("error", "server_misconfigured");
  }

  const payload = await verifyState(state, appSecret);
  if (!payload) return backToApp("error", "invalid_or_expired_state");
  const { clientId } = payload;

  try {
    // 1. Exchange code -> short-lived user access token.
    const tokenUrl = new URL(
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
    );
    tokenUrl.searchParams.set("client_id", appId);
    tokenUrl.searchParams.set("client_secret", appSecret);
    tokenUrl.searchParams.set("redirect_uri", OAUTH_CALLBACK_URL);
    tokenUrl.searchParams.set("code", code);
    const shortRes = await fetch(tokenUrl);
    const shortJson = await shortRes.json();
    if (!shortRes.ok || !shortJson.access_token) {
      return backToApp("error", "code_exchange_failed");
    }

    // 2. Exchange short-lived -> long-lived user access token.
    const longUrl = new URL(
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
    );
    longUrl.searchParams.set("grant_type", "fb_exchange_token");
    longUrl.searchParams.set("client_id", appId);
    longUrl.searchParams.set("client_secret", appSecret);
    longUrl.searchParams.set("fb_exchange_token", shortJson.access_token);
    const longRes = await fetch(longUrl);
    const longJson = await longRes.json();
    if (!longRes.ok || !longJson.access_token) {
      return backToApp("error", "token_exchange_failed");
    }
    const userToken = longJson.access_token as string;

    // 3. List Pages the user manages, with each Page's own access token.
    const pagesUrl = new URL(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`,
    );
    pagesUrl.searchParams.set("access_token", userToken);
    pagesUrl.searchParams.set(
      "fields",
      "id,name,access_token,instagram_business_account{id,username}",
    );
    const pagesRes = await fetch(pagesUrl);
    const pagesJson = await pagesRes.json();
    const pages = pagesJson.data as Array<{
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: { id: string; username: string };
    }> | undefined;

    if (!pagesRes.ok || !pages || pages.length === 0) {
      return backToApp("error", "no_pages_found");
    }

    // Pilot simplification (see CLAUDE.md): connect the first Page returned.
    // A Page picker can replace this once multi-page clients need it.
    const page = pages[0];

    const rows: Record<string, unknown>[] = [{
      client_id: clientId,
      platform: "facebook",
      page_id: page.id,
      ig_user_id: null,
      page_name: page.name,
      page_access_token: page.access_token,
      updated_at: new Date().toISOString(),
    }];
    if (page.instagram_business_account) {
      rows.push({
        client_id: clientId,
        platform: "instagram",
        page_id: page.id,
        ig_user_id: page.instagram_business_account.id,
        page_name: page.instagram_business_account.username,
        page_access_token: page.access_token,
        updated_at: new Date().toISOString(),
      });
    }

    const upsertRes = await fetch(
      `${supabaseUrl}/rest/v1/social_accounts?on_conflict=client_id,platform`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "Prefer": "resolution=merge-duplicates",
        },
        body: JSON.stringify(rows),
      },
    );
    if (!upsertRes.ok) {
      return backToApp("error", "db_write_failed");
    }

    return backToApp("success", page.name);
  } catch (e) {
    return backToApp("error", e instanceof Error ? e.message : "unknown");
  }
});
