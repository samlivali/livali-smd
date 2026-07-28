// GET /meta-oauth-start?clientId=xxx
// Builds a signed `state` and 302-redirects the browser into Meta's OAuth
// dialog. Keeping this server-side means the signing secret never has to
// touch the frontend.

import {
  GRAPH_VERSION,
  OAUTH_CALLBACK_URL,
  signState,
} from "../_shared/meta.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const clientId = url.searchParams.get("clientId");
  if (!clientId) {
    return new Response("Missing clientId query param", { status: 400 });
  }

  const appId = Deno.env.get("META_APP_ID");
  const appSecret = Deno.env.get("META_APP_SECRET");
  const configId = Deno.env.get("META_LOGIN_CONFIG_ID");
  if (!appId || !appSecret || !configId) {
    return new Response(
      "Server is not configured with META_APP_ID/META_APP_SECRET/META_LOGIN_CONFIG_ID",
      { status: 500 },
    );
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

  return Response.redirect(dialogUrl.toString(), 302);
});
