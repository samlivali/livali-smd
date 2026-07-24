# Livali SMD — project briefing

Single-file social media dashboard app for Livali's business, used to plan/track client social posts. Built from a Claude Design `.dc.html` export, hosted on GitHub Pages, backed by Supabase.

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
- **Backend**: Supabase (see below) — the only persistence layer. No other server exists (yet — see Meta integration below).

## Supabase

- Project URL: `https://adccekhhqeprxbwcentk.supabase.co` (hardcoded in the app, along with the anon key — this is intentional; access is gated by RLS policies, not secrecy).
- Single table `app_state`, single row (`id = 'singleton'`), one `data jsonb` column holding the entire app: `{ clients, posts, strategyNotes, adminUsernameOverride, adminPasswordOverride, editorUsernameOverride, editorPasswordOverride }`.
- Loaded on mount (`loadAppState`), saved via a 1.5s-debounced `scheduleSave()` → `saveAppState()`.
- **Gotcha**: `componentDidUpdate` never fires for plain `setState` updates in this dc-runtime (confirmed empirically, cost real debugging time). Every state-mutating method that touches synced data must call `this.scheduleSave()` explicitly at the end — don't rely on lifecycle hooks.
- You can inspect/patch the live row directly with `curl` using the `apikey`/`Authorization: Bearer` headers — useful for cleaning up test data (see Testing discipline below).

## Roles

Three roles, gated via `session.role` (`'admin' | 'editor' | 'client'`):

- **Admin**: full access. Only role that can manage client accounts, and the only one that can change admin/editor login credentials (`saveAdminCredentials`/`saveEditorCredentials` both hard-check `this.isAdmin`). Default login `admin` / `admin123!`, overridable in the Clients tab.
- **Editor**: added later at the user's request, sits between admin and client. Can switch between clients, fully manage posts/media/status, view Strategy — but no Clients tab, can't manage accounts or credentials. Default login `editor` / `editor123!`.
- **Client**: scoped to their own `clientId`, can approve/request changes/export, read-only otherwise.

`effectiveClientId` (which client's data admin/editor are currently viewing) falls back to `clients[0]` when nothing's explicitly selected — this was a real bug (editor had no UI path to ever set it, since only admin's Clients-tab "Manage" button did) fixed by adding the fallback to the getter itself, not just the UI.

## Data model notes

- **Platforms**: a post can target multiple (`p.platforms: string[]`). Legacy singular `p.platform` still read via `postPlatforms(p)` helper for backward compat.
- **Statuses**: same pattern, `p.statuses: string[]`, multi-select (checkboxes, not radio) — a post can be e.g. both `scheduled` and `needs-approval` at once. Legacy singular `p.status` read via `postStatuses(p)`. Actions like Approve/Request changes/Check status use `transitionStatuses(current, addId, removeIds)` to add/remove specific statuses rather than overwriting the whole field.
- **Media**: base64 data URLs (`mediaDataUrl`), 5MB client-side cap, auto-expires 48h after a post's `checkedAt` goes to `posted` (`expireMedia()`, runs on load + a 30-min interval).

## Known gotchas (don't rediscover these)

1. **No `componentDidUpdate`** — see Supabase section above.
2. **FileReader async race**: `onDraftMediaChange`'s `reader.onload` must guard with `if (!s.modal) return null;` inside the `setState` updater — the modal can close before the async read finishes, otherwise you get a spread-of-null crash.
3. **CSS Grid `width:min(Xpx,100%)` inside `display:grid;place-items:center`** resolves wrong on mobile. Fixed via `calc(100vw - 2*var(--space-4))` instead, in the `@media (max-width:760px)` block.
4. **Nested `position:fixed` overlay + event bubbling**: the fullscreen media lightbox is nested *inside* the existing view-post `.dialog-backdrop` (not a sibling) to reuse its already-correct full-viewport behavior, and its own backdrop click handler must call `e.stopPropagation()` explicitly — otherwise a click on it also bubbles up and fires the parent's close handler, closing both at once.
5. **Browser preview tool screenshot lag**: the in-session screenshot tool can return a stale frame right after a state-changing click. If a screenshot looks wrong/unclickable, re-screenshot or check actual DOM state via `javascript_tool` before concluding something's broken.
6. **Login form flakiness in the test browser**: plain `left_click` + `type` on the username/password fields sometimes drops keystrokes into the wrong field. Triple-click to select-all, or clear explicitly, before typing.

## Testing discipline

The Supabase database is the **real production database** — there's no separate test environment. Every time you test a feature that writes data:

1. Create an isolated, clearly-named test client (e.g. "Lightbox Test Co.") rather than touching the real client ("QuikDawa").
2. Use precise DOM lookups (match by exact name/text) rather than "click the first button" — a past mix-up attributed test posts to the real client's ID.
3. Clean up afterward: pull the live JSON via `curl`, filter out the test client/posts by name (keep only real clients), PATCH it back. Verify the counts before and after.

## Meta (Facebook/Instagram) integration — in progress

User wants real OAuth-connected posting/scheduling to Facebook + Instagram (not just planning). Agreed approach:

- **Phase 1 (user, external)**: create a Meta Developer App (type Business), add Facebook Login for Business, set the OAuth redirect URI to `https://adccekhhqeprxbwcentk.supabase.co/functions/v1/meta-oauth-callback`, get an App ID/Secret. Starting from scratch — no Meta dev account existed yet. **Status: waiting on user to complete this and share the App ID** (App Secret should go straight into a Supabase Edge Function secret, never into chat).
- **Phase 2 (me)**: Supabase Edge Functions — one for OAuth code exchange (keeps the App Secret server-side, stores long-lived tokens in a new table, e.g. `social_accounts`), one for scheduled publishing (cron-triggered, queries posts due to go out, calls the Graph API, updates status) — this replaces the current `checkStatus()` random-coin-flip simulation with real publishing.
- **Phase 3 (me)**: "Connect Facebook/Instagram" UI per client, connected-account display, wire real publishing into the existing post scheduler.
- Key simplification: as long as only Pages that Livali/its clients directly manage get connected, the Meta app can likely stay in **Development mode** (Admins/Testers only) and skip Meta's App Review process entirely.
- Plan is to pilot with a **test Facebook Page**, not QuikDawa's real page, until the flow is proven.
