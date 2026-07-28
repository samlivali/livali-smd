// TEMPORARY diagnostic function — not part of the app's real surface.
// Inspects what the stored Page token for a client can actually do, since
// Graph API's #200 permission errors are notoriously unspecific. Never
// returns the raw token itself.

import { GRAPH_VERSION } from "../_shared/meta.ts";

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
    return new Response("Unauthorized", { status: 401 });
  }
  const url = new URL(req.url);
  const clientId = url.searchParams.get("clientId") ?? "test-connect-1";

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const dbHeaders = {
    "apikey": serviceRoleKey!,
    "Authorization": `Bearer ${serviceRoleKey}`,
  };

  const acctRes = await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?client_id=eq.${
      encodeURIComponent(clientId)
    }&platform=eq.facebook&select=page_id,page_access_token`,
    { headers: dbHeaders },
  );
  const accts = await acctRes.json();
  if (!accts.length) {
    return new Response(JSON.stringify({ error: "no account" }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  const { page_id: pageId, page_access_token: token } = accts[0];

  const appId = Deno.env.get("META_APP_ID");
  const appSecret = Deno.env.get("META_APP_SECRET");
  const appToken = `${appId}|${appSecret}`;

  const [pageInfoRes, debugRes] = await Promise.all([
    fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}?fields=id,name&access_token=${token}`,
    ),
    fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/debug_token?input_token=${token}&access_token=${appToken}`,
    ),
  ]);

  return new Response(
    JSON.stringify({
      pageId,
      pageInfo: await pageInfoRes.json(),
      debugToken: await debugRes.json(),
    }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
});
