# Livali SMD — project briefing

Single-file social media dashboard app for Livali's business, used to plan/track/publish client social posts. Built from a Claude Design `.dc.html` export, hosted on GitHub Pages, backed by Supabase (real Auth + relational tables — see below; this replaced an earlier single-JSON-blob design).

## The one rule that matters most

**`Livali SMD.dc.html` is the only file you ever edit.** Before every commit, copy it verbatim over `index.html` (GitHub Pages serves `index.html`; the `.dc.html` name is just the original design-export filename):

```bash
cp "Livali SMD.dc.html" index.html
```

Forgetting this means the live site silently keeps serving old code.

## Architecture

- **Format**: Claude Design's `.dc.html` templating DSL — `sc-for`, `sc-if`, `{{ mustache }}` interpolation — compiled client-side by a "dc-runtime" (`support.js`) that loads React 18 + Babel Standalone from unpkg at runtime and Babel-transpiles the inline `<script data-dc-script>` block into a `class Component extends DCLogic`. There is no build step.
- **State**: all in one `Component`'s React state. `renderVals()` computes everything the template reads, in one big object, on every render.
- **Design system**: `_ds/nocturne-.../styles.css`, CSS custom properties (`--color-*`, `--space-*`, etc.), overridden in a `<style>` block for Livali's red/white/black brand.
- **Hosting**: GitHub Pages at `https://samlivali.github.io/livali-smd/`, repo `https://github.com/samlivali/livali-smd.git`. An empty `.nojekyll` file at repo root is required — Jekyll silently strips underscore-prefixed folders like `_ds/` otherwise.
- **Backend**: Supabase (project ref `adccekhhqeprxbwcentk`) — Auth + Postgres (relational tables + RLS) + Edge Functions. No other server exists.
- **Local preview doesn't work in a sandboxed browser tool**: the dc-runtime loads React/Babel from unpkg with `crossorigin` + SRI, which gets silently blocked when the page itself is served from `localhost` in some sandboxed browser environments (confirmed: works fine on the real `https://samlivali.github.io` origin, fails on a local static server in that environment). If you hit this, verify against the deployed site instead of chasing a local repro.

## Supabase: schema and auth

A security review (2026-07) found the original design — one `app_state` table, single JSONB blob, RLS granting **unconditional public read/write** to anyone holding the (publicly hardcoded) anon key — let anyone read every client's plaintext credentials and overwrite `adminUsernameOverride`/`adminPasswordOverride` to hijack admin access outright. It also meant a legitimate logged-in client's browser received every other client's data too, filtered only client-side. Real per-client isolation needs real rows (not one shared JSON blob) and real RLS needs a real server-verified identity (not client-side string comparison) — so both were rebuilt. `app_state` itself was renamed to `app_state_deprecated_20260730` (kept as a cooling-off safety net, RLS policies dropped) rather than deleted outright; drop it for real once nothing's needed it for a while.

**Tables** (all `public` schema, RLS enabled, **zero grants to `anon`** — a deliberate contrast with the old `app_state`):
- `clients` (`id text pk`, `name`) — id format `'c' + Date.now() + random suffix`, preserved verbatim from the old JSON during migration.
- `profiles` (`id uuid pk references auth.users`, `role admin|editor|client`, `client_id` nullable FK, `username`, `email`) — one row per login identity, admin/editor/client uniformly. `email` is a **synthetic** address (`lower(username)+'@livali-internal.invalid'`), computed client-side, never a real inbox — password-reset-by-email can't work for these accounts, resets go through the admin-only Edge Functions below.
- `posts` — same fields as before but relational: `client_id`, `platforms text[]`, `post_date`, `post_time`, `title`, `caption`, `media_data_url`, `media_type`, `media_name`, `media_expired`, `pillar`, `assignee`, `statuses text[]`, `client_note`, `checked_at`. No more legacy singular `platform`/`status` fallback — migration normalized everything to arrays once, the table enforces it going forward.
- `strategy_notes` (`client_id`, `period_key`, `note`) — `period_key` is what used to be baked into the JSON key (`'YYYY-MM'` for month mode, week-start ISO date for week mode); `(client_id, period_key)` is now a real unique composite key. **Admin/editor only, full stop** — clients never had a Strategy tab, and RLS enforces that too now (verified: even a client reading their *own* client_id's note gets nothing).
- `social_accounts` (+ `social_accounts_public` view) — real OAuth Page/IG tokens, see Meta integration section.

**RLS shape**: admin/editor see everything; client role scoped to `client_id = auth.jwt()->>'client_id'`. Client-role *writes* on `posts` go through two `SECURITY DEFINER` RPCs (`approve_post`, `submit_change_request`) rather than a raw UPDATE grant — Postgres RLS can't restrict which *columns* a role touches on the same row, and a client should only ever flip statuses/leave a note, never edit caption/media/schedule. Verified directly: a client's raw `PATCH` on a post silently no-ops (0 rows affected, RLS-invisible), the RPC path works.

**Custom Access Token Auth Hook** (`custom_access_token_hook` Postgres function, wired via `supabase/config.toml`'s `[auth.hook.custom_access_token]` + `supabase config push`) injects `user_role` and `client_id` into every issued JWT by looking up `profiles`, so RLS policies read `auth.jwt()->>'user_role'` directly with no per-request join. **Three sharp edges hit and fixed while building this — don't reintroduce them:**
1. The claim is named `user_role`, **never** `role` — PostgREST reads a JWT's `role` claim to `SET ROLE` on the Postgres connection; overwriting it with `'admin'`/`'client'` breaks API access for every signed-in user, not just RLS.
2. The hook function must be `SECURITY DEFINER` — it runs as `supabase_auth_admin`, which has no grant on `profiles` and no way past its RLS otherwise (silent "unexpected_failure" from GoTrue, not an obvious error pointing at the real cause).
3. For a mixed-null composite row (e.g. an admin profile's `client_id` is legitimately `NULL`), **`row IS NOT NULL` is not the negation of `row IS NULL`** — both are false unless *every* field matches. Use `FOUND` after `SELECT INTO`, not a null-check on the record. Relatedly, `jsonb_set(target, path, new_value)` returns SQL `NULL` for the **entire** result if `new_value` is SQL `NULL` (not a JSON null) — build the claims update with `jsonb_build_object()`/`||` instead, and only include a key at all when there's a real value (GoTrue's own claims-schema validation separately rejects a present key with a `null` value — omit the key, don't null it).

**Auth config gotcha**: `[auth.email] enable_signup = false` in `config.toml` doesn't just disable self-serve signup — it disables the **entire email provider**, sign-in included (confirmed via `/auth/v1/settings` → `external.email: false`). Leave `[auth.email].enable_signup = true`; the top-level `[auth].enable_signup = false` is what actually blocks public `signUp()` (which matters since `supabase-js` is loaded client-side with the anon key — public signup would otherwise be freely callable).

New client/admin/editor accounts and credential changes go through Edge Functions using the Admin API (`service_role`), never a plaintext field: `admin-create-client`, `admin-update-credentials`, `admin-delete-client` — all admin-only (checked via decoded JWT claims, not just `verify_jwt`), all deployed with default JWT verification.

## Roles

Three roles, sourced from real Supabase Auth JWT claims (`user_role`/`client_id`), decoded client-side from `session.access_token` into `this.state.session`:

- **Admin**: full access. Only role that can manage client accounts or change admin/editor credentials.
- **Editor**: can switch between clients, fully manage posts/media/status, view Strategy — no Clients tab, can't manage accounts or credentials.
- **Client**: scoped to their own `clientId` via the JWT claim, can approve/request changes/export, read-only otherwise (enforced server-side now, not just hidden in the UI).

`effectiveClientId` (which client's data admin/editor are currently viewing) falls back to `clients[0]` when nothing's explicitly selected.

Login: `usernameToEmail(u)` maps a typed username to the synthetic email, then `supabase.auth.signInWithPassword`. No more client-side default-credential getters (`effectiveAdminUsername` etc.) — those were deleted along with the plaintext-password model they supported.

## Data model notes

- **Platforms/statuses**: `p.platforms`/`p.statuses` are real Postgres `text[]` columns now — always arrays, no legacy singular fallback to worry about in new code (the migration normalized old singular `platform`/`status` fields once, going in). `transitionStatuses(current, addId, removeIds)` still adds/removes specific statuses rather than overwriting the whole field.
- **Media**: base64 data URLs (`mediaDataUrl`/`media_data_url`), 5MB client-side cap, auto-expires 48h after a post's `checkedAt` goes to `posted` (`expireMedia()`, runs on load + a 30-min interval; the frontend now PATCHes only the affected row(s), computed *before* calling `setState` to avoid comparing against already-updated state).
- **Field name mapping**: the frontend keeps the original camelCase shape (`clientId`, `mediaDataUrl`, `checkedAt`, ...) in its own state for minimal template/render changes, converting to/from the table's snake_case columns (`client_id`, `media_data_url`, `checked_at`, ...) via `rowToPost()`/`postToRow()` helpers at the load/save boundary.

## Known gotchas (don't rediscover these)

1. **Auth hook pitfalls** — see the three sharp edges in the Supabase section above (claim naming, SECURITY DEFINER, row-null asymmetry + jsonb_set null propagation).
2. **FileReader async race**: `onDraftMediaChange`'s `reader.onload` must guard with `if (!s.modal) return null;` inside the `setState` updater — the modal can close before the async read finishes, otherwise you get a spread-of-null crash.
3. **CSS Grid `width:min(Xpx,100%)` inside `display:grid;place-items:center`** resolves wrong on mobile. Fixed via `calc(100vw - 2*var(--space-4))` instead, in the `@media (max-width:760px)` block.
4. **Nested `position:fixed` overlay + event bubbling**: the fullscreen media lightbox is nested *inside* the existing view-post `.dialog-backdrop` (not a sibling) to reuse its already-correct full-viewport behavior, and its own backdrop click handler must call `e.stopPropagation()` explicitly — otherwise a click on it also bubbles up and fires the parent's close handler, closing both at once.
5. **Browser preview tool screenshot lag**: the in-session screenshot tool can return a stale frame right after a state-changing click. If a screenshot looks wrong/unclickable, re-screenshot or check actual DOM state via `javascript_tool` before concluding something's broken.
6. **Login form flakiness in the test browser**: plain `left_click` + `type` on the username/password fields sometimes drops keystrokes into the wrong field. Triple-click to select-all, or clear explicitly, before typing.
7. **GitHub Pages can silently stop auto-deploying** — happened for two consecutive pushes (confirmed via the Actions API: zero build runs queued, not just slow). Fix: Settings → Pages → re-click Save on the existing "Deploy from a branch" source (no actual change needed) to force a fresh trigger. Check this if a push doesn't show up live after a couple of minutes.
8. **Meta permission availability is tied to configured "Use Cases", not just the Login Configuration's checkboxes** — `pages_manage_posts` never appeared as selectable *anywhere* (not in Standard or Advanced Access) until a Facebook Page use case ("Manage everything on your Page") was added under the app's **Use Cases** page. If a permission won't show up no matter what's checked in a Login Configuration, check Use Cases first.
9. **Testing REST calls from Bash**: `require('/c/Users/...')` inside a `node -e` script does **not** get Git-Bash's POSIX-path translation (that only applies to actual argv tokens) — pass file paths as `process.argv[1]` and read with `fs.readFileSync(process.argv[1])`, not embedded in the script string.

## Testing discipline

The Supabase database is **real production data** — there's no separate test environment.

- Real client accounts are now real Supabase Auth users (see Supabase section) — never touch a real client's `auth.users`/`profiles` row directly. For disposable test accounts, create a throwaway Auth user via the Admin API + a `profiles` row, and delete both afterward (this is how the auth-hook and RLS behavior were verified this session).
- For ad hoc `posts`/`clients` test rows, use a clearly-fake id (e.g. `zz-test-...`) and delete it when done — don't attribute test data to the real client ("QuikDawa").
- You can `curl` any table directly with a real user's JWT (`POST /auth/v1/token?grant_type=password` with their synthetic email, then use the returned `access_token` as the Bearer token) to verify RLS/claims behavior without needing the frontend at all — much faster than driving the browser for backend-only checks.

## Meta (Facebook/Instagram) integration

Real OAuth-connected posting to Facebook is **working end-to-end**, verified with a real post to a test Page. Instagram publishing is not yet built (see below).

- **Meta app**: Business-type, "Facebook Login for Business" product, App ID `1465456148962040`. App Secret is in the `META_APP_SECRET` Edge Function secret (never in chat, never in the repo). Business Login requires a `config_id` (from a saved Login Configuration, `META_LOGIN_CONFIG_ID` secret) rather than a raw `scope` param — passing `scope` 404s with a vague "This content isn't available" error.
- **`social_accounts`**: real OAuth Page/IG tokens per client, FK'd to `clients.id`. RLS enabled, zero anon/authenticated policies — only `service_role` (Edge Functions) touches it. `social_accounts_public` view exposes just `client_id, platform, page_name, connected_at` for the frontend to show connection status.
- **`meta-oauth-start`** (`GET ?clientId=xxx`, requires a valid Supabase Auth JWT): checks the caller's role/client_id claim (a client may only request their own `clientId`; admin/editor any), validates the `clientId` exists, signs a `state` (HMAC-SHA256 keyed on `META_APP_SECRET`, embeds `clientId` + nonce + 10-min expiry), returns `{ url }` as JSON (not a redirect — a plain `<a href>` can't carry the Authorization header the frontend needs to send; it does `fetch()` then `window.location.href = url` itself).
- **`meta-oauth-callback`**: verifies `state`, exchanges `code` → short-lived → long-lived Page token, calls `/me/accounts` for Pages (**picks the first Page returned** — pilot simplification, revisit if a client ever needs a Page picker), pulls `instagram_business_account` off that Page if linked, upserts into `social_accounts`, redirects to `https://samlivali.github.io/livali-smd/?meta_connect=success|error&meta_detail=...`.
- **`publish-scheduled-posts`**: cron-triggered every 5 min (`pg_cron`+`pg_net`, secured by a `CRON_SECRET` header pulled fresh each run from a Supabase Vault secret — never embed a raw secret in a committed migration/SQL file). Queries `posts` directly for due, `platforms = ['facebook']`-only, non-video-media rows (interprets `post_date`/`post_time` as Africa/Nairobi, UTC+3); publishes via direct multipart upload (text + single image) to the Graph API; updates `statuses`/`checked_at` with a plain `PATCH` (no more atomic-JSON-patch RPC — that only existed for the old JSON blob). Instagram is deliberately out of scope here: its API requires a publicly-hosted image URL, which needs a Storage bucket not yet built.
- **Still not built**: the actual "Connect Facebook/Instagram" UI in the app (a button calling `meta-oauth-start` + reading `social_accounts_public` for status) — everything above has only been exercised via direct `curl` calls with manually-obtained tokens/URLs. `checkStatus()`'s coin-flip simulation is also still in place (not yet repointed at real publishing) since this needs its own decision on rollout.
- Key simplification: as long as only Pages that Livali/its clients directly manage get connected, the Meta app can stay in **Development mode** and skip Meta's App Review process — confirmed workable, but **permission availability is tied to configured Use Cases** (see gotcha #8 above), not just Development-mode admin/tester status.
- Piloted with a **test Facebook Page** ("Tile Mate Kenya"), not a real client's page, until proven — that Page now has a real leftover test post from verification (harmless, but not auto-cleaned-up since deleting a live Facebook post isn't something to do unprompted).
