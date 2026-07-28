// Cron-triggered (every 5 min, via pg_cron+pg_net, see setup notes in
// CLAUDE.md). Replaces the frontend's checkStatus() coin-flip simulation
// with real Facebook publishing.
//
// Scope for this pass, deliberately: Facebook only (text + single image).
// Instagram requires a publicly-hosted image URL (no raw upload support in
// its API), which needs a Storage bucket we haven't wired in yet — posts
// targeting anything other than exactly ['facebook'], or carrying video
// media, are left untouched (still 'scheduled') rather than guessed at.
//
// Posts live in one JSON blob (app_state.data.posts) that the frontend
// read-modify-writes wholesale on every save. To avoid this function
// racing that, status changes go through the update_post_status() Postgres
// function (see migration 20260725063707), which patches a single array
// element in one atomic UPDATE instead of rewriting the whole blob.

import { GRAPH_VERSION } from "../_shared/meta.ts";

const NAIROBI_OFFSET = "+03:00";

function postPlatforms(p: any): string[] {
  if (p.platforms && p.platforms.length) return p.platforms;
  if (p.platform) return [p.platform];
  return ["facebook"];
}
function postStatuses(p: any): string[] {
  if (p.statuses && p.statuses.length) return p.statuses;
  if (p.status) return [p.status];
  return ["needs-approval"];
}

function dueAtUtc(p: any): Date | null {
  if (!p.date || !p.time) return null;
  const d = new Date(`${p.date}T${p.time}:00${NAIROBI_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const [, contentType, b64] = match;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response("Server misconfigured", { status: 500 });
  }
  const dbHeaders = {
    "Content-Type": "application/json",
    "apikey": serviceRoleKey,
    "Authorization": `Bearer ${serviceRoleKey}`,
  };

  const stateRes = await fetch(
    `${supabaseUrl}/rest/v1/app_state?id=eq.singleton&select=data`,
    { headers: dbHeaders },
  );
  if (!stateRes.ok) {
    return new Response("Failed to load app_state", { status: 502 });
  }
  const stateRows = await stateRes.json();
  const posts: any[] = stateRows?.[0]?.data?.posts ?? [];

  const now = new Date();
  const dueFacebookOnly = posts.filter((p) => {
    if (!postStatuses(p).includes("scheduled")) return false;
    const plats = postPlatforms(p);
    if (plats.length !== 1 || plats[0] !== "facebook") return false;
    if (p.mediaDataUrl && p.mediaType === "video") return false;
    const due = dueAtUtc(p);
    return due !== null && due <= now;
  });

  const results: Record<string, string> = {};

  for (const post of dueFacebookOnly) {
    try {
      const acctRes = await fetch(
        `${supabaseUrl}/rest/v1/social_accounts?client_id=eq.${
          encodeURIComponent(post.clientId)
        }&platform=eq.facebook&select=page_id,page_access_token`,
        { headers: dbHeaders },
      );
      const accts = acctRes.ok ? await acctRes.json() : [];
      if (!accts.length) {
        results[post.id] = "skipped: no connected facebook account";
        continue;
      }
      const { page_id: pageId, page_access_token: pageToken } = accts[0];
      const caption = (post.caption && post.caption.trim()) || post.title ||
        "";

      let graphRes: Response;
      if (post.mediaDataUrl && post.mediaType === "image") {
        const blob = dataUrlToBlob(post.mediaDataUrl);
        if (!blob) {
          results[post.id] = "skipped: unreadable media";
          continue;
        }
        const form = new FormData();
        form.append("caption", caption);
        form.append("access_token", pageToken);
        form.append("source", blob, post.mediaName || "image.jpg");
        graphRes = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/photos`,
          { method: "POST", body: form },
        );
      } else {
        graphRes = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/feed`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              message: caption,
              access_token: pageToken,
            }),
          },
        );
      }

      const ok = graphRes.ok;
      const checkedAt = new Date().toISOString();
      const newStatuses = ok ? ["posted"] : ["missed"];

      const rpcRes = await fetch(
        `${supabaseUrl}/rest/v1/rpc/update_post_status`,
        {
          method: "POST",
          headers: dbHeaders,
          body: JSON.stringify({
            p_post_id: post.id,
            p_statuses: newStatuses,
            p_checked_at: checkedAt,
          }),
        },
      );

      if (!ok) {
        const errBody = await graphRes.text();
        results[post.id] = `missed: graph api error: ${errBody.slice(0, 200)}`;
      } else if (!rpcRes.ok) {
        results[post.id] = "posted to facebook but status update failed";
      } else {
        results[post.id] = "posted";
      }
    } catch (e) {
      results[post.id] = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return new Response(
    JSON.stringify({ processed: dueFacebookOnly.length, results }),
    { headers: { "Content-Type": "application/json" } },
  );
});
