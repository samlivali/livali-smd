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
// Posts now live in a real `posts` table (see the Phase 0 migration) —
// status updates are a plain PATCH on the row by id, no more atomic-JSON-
// patch RPC needed (that was only ever a workaround for the old
// app_state JSON blob, which this table replaces).

import { GRAPH_VERSION } from "../_shared/meta.ts";

const NAIROBI_OFFSET = "+03:00";

function dueAtUtc(dateStr: string, timeStr: string): Date | null {
  if (!dateStr || !timeStr) return null;
  const d = new Date(`${dateStr}T${timeStr.slice(0, 5)}:00${NAIROBI_OFFSET}`);
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

  const postsRes = await fetch(
    `${supabaseUrl}/rest/v1/posts?statuses=cs.{scheduled}&select=*`,
    { headers: dbHeaders },
  );
  if (!postsRes.ok) {
    return new Response("Failed to load posts", { status: 502 });
  }
  const posts: any[] = await postsRes.json();

  const now = new Date();
  const dueFacebookOnly = posts.filter((p) => {
    const plats: string[] = p.platforms || [];
    if (plats.length !== 1 || plats[0] !== "facebook") return false;
    if (p.media_data_url && p.media_type === "video") return false;
    const due = dueAtUtc(p.post_date, p.post_time);
    return due !== null && due <= now;
  });

  const results: Record<string, string> = {};

  for (const post of dueFacebookOnly) {
    try {
      const acctRes = await fetch(
        `${supabaseUrl}/rest/v1/social_accounts?client_id=eq.${
          encodeURIComponent(post.client_id)
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
      if (post.media_data_url && post.media_type === "image") {
        const blob = dataUrlToBlob(post.media_data_url);
        if (!blob) {
          results[post.id] = "skipped: unreadable media";
          continue;
        }
        const form = new FormData();
        form.append("caption", caption);
        form.append("access_token", pageToken);
        form.append("source", blob, post.media_name || "image.jpg");
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

      const patchRes = await fetch(
        `${supabaseUrl}/rest/v1/posts?id=eq.${encodeURIComponent(post.id)}`,
        {
          method: "PATCH",
          headers: dbHeaders,
          body: JSON.stringify({ statuses: newStatuses, checked_at: checkedAt }),
        },
      );

      if (!ok) {
        const errBody = await graphRes.text();
        results[post.id] = `missed: graph api error: ${errBody.slice(0, 200)}`;
      } else if (!patchRes.ok) {
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
