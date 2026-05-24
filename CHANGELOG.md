# Changelog

All notable changes to Arkon are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added

- **Google login.** New endpoint `POST /api/auth/google` verifies a Google ID
  token and signs in the employee whose verified email matches an active row
  in `employees`. Unknown or inactive emails return `401 User does not exist`
  — no auto-provisioning. The login page renders a "Continue with Google"
  button when `GOOGLE_CLIENT_ID` (backend audience) and
  `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (frontend) are configured; otherwise the
  button is hidden and only password login is shown. Password login is
  unchanged.

### Changed

- **MCP `tools/list` now scopes by bearer-token identity.** Reviewer- and
  contributor-tier tools no longer appear in the catalog for callers who
  couldn't use them. Read-only employees see the read surface only;
  workspace contributors additionally see propose/resubmit/withdraw;
  workspace editors and `wiki:write:all` holders see the review queue
  and direct-write tools; admins see everything. Unauthenticated and
  invalid-token callers see only the read surface, with an
  "Authenticate to use" hint prepended to each tool description so the
  client can guide the user back to token configuration. Implemented as
  a FastMCP middleware (`ScopedToolsMiddleware`) reading a per-tool
  `ToolRequirement` declared via the new `@kb_tool` decorator —
  per-resource checks inside tool bodies are unchanged and remain the
  security boundary. Role changes require an MCP reconnect to take
  effect.
- `ResolvedIdentity` now carries `workspace_roles: dict[str, str]`
  (workspace_id → role) so visibility predicates run without an extra
  DB round-trip per `tools/list`.

---

## [0.7.4] — 2026-05-20

Member-management overhaul, dedicated wiki review console, and an MCP
scope-leak fix that had been making project-scoped wiki pages invisible
to their own workspace members. Three new features and two bug fixes
on top of the 0.7.3 critical-review pass.

### Added

- **Dedicated 3-pane wiki review console at `/wiki/review`** — built for
  high-volume reviewers who would otherwise burn one full page navigation
  per draft. Left pane lists the queue with `To review` / `Mine` scope
  toggle and status filter; center pane shows the diff / proposed /
  current tabs with a compare-with dropdown across sibling drafts on the
  same page; right pane carries author stats, AI pre-review verdict, and
  the action stack. URL state (`?draft=&status=&mine=`) is the source of
  truth so deep links and browser history work. Keyboard shortcuts:
  `j`/`k` next-prev, `a` approve, `c` request changes, `r` reject,
  `Esc` cancel, `?` help overlay. The existing `WikiDraftBanner` on
  `/wiki/[slug]` is intentionally kept for casual reviewers.
- **Bulk workspace member invite** — typeahead + chips multi-select
  replaces the one-add-per-click picker. Type to filter by name/email,
  `↑↓` navigate, `Enter` pick, `Backspace` pop the last chip. A single
  role applies to the whole batch. New backend endpoint
  `POST /api/projects/{id}/members/bulk` accepts `{employee_ids, role}`
  and processes each row in its own SAVEPOINT so a duplicate /
  IntegrityError / missing employee in the batch doesn't poison the
  rest. Chips for errored employees stay in the input so admins can
  fix and retry without re-typing.
- **Workspace-scoped candidate endpoints** — `GET
  /api/projects/{id}/members/candidates` (workspace admin) and
  `GET /api/projects/{id}/sources/candidates` (workspace editor+) return
  not-yet-linked employees / sources with `?search=` substring filter.
  Replaces the previous frontend dependency on the org-wide
  `/api/employees` / `/api/sources` lists.
- **Out-of-scope discovery hint in MCP** — when a non-admin caller's
  `search_wiki` query matches pages in a department or workspace they
  can't access, the response appends an "Out-of-scope matches" section
  listing `(scope_label, count)` groups (e.g. "3 page(s) in department
  HR — contact the HR admin to request access"). `read_wiki_page` does
  the same when the slug exists in an inaccessible scope. The hint
  leaks **only** scope label + count — titles and content are never
  surfaced across a permission boundary.
- **Scrollable + filterable scope legend on the wiki graph** — the
  `Scope` section grows a `Filter scopes…` input and a `max-h-44` scroll
  cap once it has more than 8 entries. Below that threshold it stays
  identical to before. Header shows `visible/total` while filtering.

### Fixed

- **Project-scope blindspot in wiki read path** — the MCP wiki layer
  filtered visible pages with a `global + own_dept` OR-clause that
  completely omitted project-scoped pages, even for the workspace's
  own members. `search_wiki` returned 0 hits against pages a user
  obviously had access to, forcing them to drill into raw sources to
  discover the wiki page existed. New helper
  `_scope_filter_for_identity(department_id, project_ids)` ORs the
  third branch in; `ResolvedIdentity` carries a `project_ids` list
  populated from active workspace memberships. `search_pages_semantic`,
  `list_pages`, and `read_wiki_page` all updated. Incidental: admins
  were also being scope-filtered to own_dept — `all_scopes=True` now
  bypasses the filter entirely for admin identities.
- **Workspace admins couldn't open their own workspace** — the project
  detail page fetched `/api/employees?page_size=500` to populate the
  picker, which required `org:employees:read` — a permission workspace
  admins do not have. The 403 sank the `Promise.all` and showed
  "Failed to load project details" with no fallback. Fixed by swapping
  to the new candidate endpoints, using `Promise.allSettled` so a 403
  on the side fetches no longer kills the page, and computing
  `canAdminWorkspace = isOrgAdmin || workspaceRole === 'admin'` so the
  picker UI shows for workspace admins who aren't org admins.

### Docs

- `docs/ACCESS-CONTROL.md`, `docs/WIKI.md`, `docs/ARCHITECTURE.md`,
  `docs/MCP.md` all caught up: project-scope OR branch documented,
  AI pre-review (L1→L4) + resubmit race guard + stuck-running sweep,
  review console layout + shortcuts, token hashing at rest + forced
  rotation after migration 027, draft state machine with the
  needs_revision loop, new worker tasks and cron jobs, OOS hint
  format, and updated data-model section.

---

## [0.7.3] — 2026-05-20

Follow-up critical review on top of 0.7.2 — three concurrency / data-loss
issues uncovered by re-reading the AI pre-review path, bulk-approve loop,
and approve_draft scope parser after the 0.7.2 fixes settled.

### Fixed

- **AI pre-review stale verdict on resubmit** — the L3/L4 worker
  could finish a check pass against the OLD `content_md` of a draft
  that the author had already resubmitted, then overwrite the newer
  worker's verdict on commit. The submit path now passes
  `revision_round` to the job, and the runner `refresh()`-es the draft
  immediately before writing its verdict — if the round has bumped it
  drops the stale result. A newer worker is already queued for the
  new content.
- **Bulk approve ORM identity-map pollution** — `db.begin_nested()`
  correctly rolled back the SAVEPOINT in Postgres on a per-draft
  failure, but SQLAlchemy does NOT revert in-memory attribute
  mutations on persistent objects when a savepoint rolls back. A
  failed approve would leave `page.version = N+1` / `draft.status =
  "approved"` on the still-attached instances, polluting the next
  iteration that touched the same page (wrong version label,
  miscounted notification). The router now `db.expire(draft, page)`
  in the savepoint's except branch so a fresh load reads true DB state.
- **`scope_id` parse crashed on non-string non-UUID values** —
  `wiki_service.approve_draft` only caught `ValueError` when reading
  `suggested_metadata.scope_id`. Hand-crafted or migrated rows with
  e.g. an int there would `TypeError` in `uuid.UUID(...)` and surface
  as a 500. Now catches `(ValueError, TypeError)` and `isinstance`-
  validates, matching the defensive parse in
  `wiki_drafts._can_review_draft`.

### Added

- **`sweep_stuck_ai_review_cron`** — runs every 10 minutes; resets any
  draft stuck in `ai_check_status="running"` for more than
  `2 × worker_job_timeout` (min 30 min) back to `"skipped"`. Catches
  the case where the AI worker process is SIGKILL/OOM-killed AFTER
  committing `running` but BEFORE finishing the check pass — the
  in-worker try/except can't run during a hard process death, so
  without the sweep the UI would show a perpetual spinner. The
  `ai_pre_review_draft_task` signature is backwards-compatible:
  jobs enqueued by older code (without `expected_round`) still run
  to completion but skip the race guard.

---

## [0.7.2] — 2026-05-20

Critical-review batch: data-integrity, race, and security findings from a
fresh audit of the draft lifecycle, MCP auth, and AI pre-review surfaces.

### Security

- **MCP tokens hashed at rest (migration 027)** — `employees.mcp_token` was
  stored in plaintext and looked up via direct equality. A DB read therefore
  exposed every active token. New columns `mcp_token_hash`
  (HMAC-SHA256+pepper), `mcp_token_prefix` (UI display), and
  `mcp_token_rotated_at` replace the lookup path. The migration NULLs every
  existing plaintext token so **all users must rotate their MCP token via
  the portal after deploy**. Configure `MCP_TOKEN_PEPPER` in env before
  rolling out. Self-service `POST /my/mcp-token` now always issues a fresh
  token (no read-back path).

### Fixed

- **`bulk_approve_drafts` poisoned session** — when one draft's approve
  raised mid-flush, the outer AsyncSession entered a `PendingRollbackError`
  state and silently failed every subsequent iteration. Each draft now runs
  inside its own SAVEPOINT (`db.begin_nested()`), so a single failure
  rolls back only that draft and the rest of the batch commits cleanly.
- **`approve_draft` lost-update race** — two reviewers approving distinct
  drafts on the same page could both observe `version=N` before the
  advisory lock and then race to write `N+1`. The page row is now
  `session.refresh()`-ed inside the locked critical section so writers
  see committed state.
- **`scope_id` parsing crash on non-string values** — `_can_review_draft`
  and `_enqueue_ai_review` now catch `TypeError` and reject non-UUID
  values defensively instead of leaking junk down to `get_workspace_role`.

### Changed

- **AI pre-review fully async** — submit/resubmit no longer runs any check
  layer inline. The arq worker now executes L1 (regex), L2 (structural),
  L3 (semantic), and L4 (LLM) end-to-end. Drafts initially surface as
  `ai_check_status="queued"`; if Redis is unreachable the status flips to
  `"skipped"` rather than getting stuck on `"running"`. Eliminates the
  per-request LLM call that previously held a FastAPI worker for seconds
  on every draft submission.
- **MCP `last_connected` debounced** — the auth path used to issue a
  `UPDATE employees SET last_connected = now()` + `COMMIT` on every tool
  call, generating one DB write per Claude Desktop request. Updates are
  now rate-limited to once per 60 s per employee; the commit is also
  skipped entirely when no write occurred.
- **Sibling-draft notifications batched** — `notify_approved` now uses a
  new `notify_each` helper to emit all cross-author notifications in a
  single `add_all` instead of N round-trips.
- **MCP `create_wiki_page` whitespace check** — added the `isspace`
  guard that `propose_wiki_create` already had, plus consistent
  `slug.strip()` at both entry points.

### Notes

- Item "project-membership grants access regardless of
  `allowed_knowledge_types`" was confirmed as **intent** during review.
  `apply_scope_filter`'s docstring now explicitly says so to deter a
  future accidental flip to AND semantics.

---

## [0.7.1] — 2026-05-20

Hotfix for a race condition in the MRP REFINE phase that surfaced while
compiling longer source documents (observed on
`meeting-notes-260519-2124-chien…`). No schema migration, no API change.

### Fixed

- **MRP REFINE concurrent-session race** — Phase 3 fanned out up to
  `MAX_WRITER_CONCURRENCY` page writers via `asyncio.gather`, all
  sharing the orchestrator's single `AsyncSession`. SQLAlchemy
  `AsyncSession` is not safe for concurrent use, so simultaneous
  `get_page_by_slug` lookups (UPDATE fetches plus the `read_kb_page`
  tool inside the complex writer's agent loop) raced and corrupted
  the session, causing intermittent draft generation failures on
  documents with several UPDATE pages or a large existing wiki.
  Each `_write_one` now opens its own session from
  `async_session_factory`; the orchestrator's session is reserved for
  the final `plan.plan_json` commit.

---

## [0.7.0] — 2026-05-19

Scaling the contribute/review workflow: review queue + bulk approve, author
trust signals, expertise-based reviewer routing, outline-aware diff,
gap-to-page deep-link, and external notification channels (email + webhook).
No schema migration — all features build on existing tables.

### Added

- **Review queue page (`/wiki/queue`)** listing every draft the current
  user can review across scopes, with status filter (pending /
  needs_revision / approved / rejected). Supports multi-select +
  bulk-approve; per-draft AI status chip, author trust chip, revision
  round, and submission age. Header button on `/wiki` deep-links here.
- **Bulk approve endpoint** `POST /wiki/drafts/bulk-approve` — processes
  each draft independently (per-item conflict / permission / not-found
  handling), commits the batch, and emits notifications for the
  approved set. Result payload reports approved / skipped / errored
  counts plus per-item messages.
- **Author trust signals** — `DraftResponse.author_stats` now exposes
  `{approved, rejected, needs_revision, total_reviewed, accuracy}` over
  the author's lifetime drafts. Banner and queue both render a chip
  coloured by tier (high / ok / low) with hover-tooltip detail.
- **Expertise-based reviewer suggestions** —
  `DraftResponse.suggested_reviewers` lists up to 3 employees ranked by
  past edit / approval activity on pages with overlapping
  `knowledge_type_slugs` OR in the same scope. Banner surfaces them so
  reviewers know who normally handles a topic.
- **Outline-aware diff view** — `WikiDraftDiff` groups hunks under their
  nearest preceding heading. Unchanged sections collapse automatically;
  changed sections stay open and are flagged in the section header.
  Pre-heading content (intro / frontmatter) renders ungrouped.
- **Knowledge-gap deep link** — the `/admin/statistics` Gaps tab's
  "Create draft →" link routes to `/wiki?new=1&title=<topic>`, which now
  auto-opens the create dialog with the gap topic pre-filled in the
  title field.
- **External notification channels (permissive)**
  - **Email (SMTP)**: per-recipient delivery; multiple notifications in
    the same request are batched into one email. Configured via
    `smtp_enabled / smtp_host / smtp_port / smtp_username / smtp_password
    / smtp_from / smtp_use_tls` keys in `app_config`. Sensitive keys
    (`smtp_password`) are encrypted at rest via the existing
    `ConfigService` Fernet layer.
  - **Webhook (generic JSON POST)**: single endpoint receives
    `{events: [{id, type, subject, body, target_type, target_id,
    recipient_id, actor_id, created_at}]}`. Optional HMAC secret signs
    the body in `X-Arkon-Signature: sha256=<hex>`.
  - Both channels run **after request commit** via a FastAPI middleware
    that drains a per-request notification staging buffer; errors are
    logged and swallowed so the contribution flow never breaks.
  - New settings panel **Notification channels** in `/settings` lets
    admins toggle each channel, edit credentials, and save without
    leaving the page.
- New runtime dependency: `aiosmtplib>=3.0.0` for async SMTP.

### Changed

- `_can_review_draft` is now the canonical reviewer-permission check;
  bulk-approve and the new queue both route through it so create drafts
  and edit drafts behave the same way.
- `notification_service.notify` / `notify_many` automatically stage
  every created `Notification` on the current request's contextvar; no
  per-route changes required for the new dispatch path.
- `_is_sensitive(key)` in `ConfigService` recognises `smtp_password` and
  `webhook_secret` so they round-trip encrypted.

### Deferred to 0.8

- Per-event channel routing (e.g. only ship `approved` events to email,
  send everything to the webhook).
- Auto-fast-track for high-trust authors (auto-approve after N hours
  with no review). Trust signals exist; the automation does not.
- Slack/Teams-native adapters (current webhook is intentionally generic).

---

## [0.6.0] — 2026-05-19

Contribute / review vision pass. Adds an AI pre-review layer that annotates
every wiki draft (PII, broken wikilinks, duplicates, tone / factual sniff),
a side-by-side diff view in the reviewer banner, and the ability for any
contributor to propose brand-new wiki pages. Permissive throughout — the AI
flags, the human decides.

### Added

- **AI pre-review (permissive)** for wiki drafts. Four layers run on every
  submit / resubmit:
  - **L1 regex (sync)** — emails, phone numbers, national IDs, AWS / GitHub /
    Anthropic / Google API keys, JWTs, private-key blocks. Suppressible
    inline with `<!-- pii-allow: <reason> -->` markers above the match.
  - **L2 structural (sync)** — broken wikilinks, self-links, length sanity,
    non-incremental heading jumps, unclosed code fences.
  - **L3 semantic (async)** — embedding similarity vs existing pages to
    flag potential duplicates (>0.85 cosine).
  - **L4 LLM judgment (async)** — tone consistency, page_type scope fit,
    factual concerns. Uses the admin-configured LLM via `ProviderRegistry`.
  - Results land in `wiki_page_drafts.ai_check_results` JSONB with a
    `summary` and per-check entries. Status flows
    `pending` → `running` → `passed` / `warned` / `failed`. **Nothing
    blocks submission** — every flag is advisory. Disable globally with
    the `ai_pre_review_enabled` config key.
- **Async worker task** `ai_pre_review_draft_task` registered in
  `WorkerSettings.functions`. L1/L2 run inside the request; L3/L4 are
  enqueued and update the draft when done.
- **Re-run on resubmit** — every author resubmission clears the AI state,
  re-runs L1+L2 synchronously, re-enqueues L3+L4, and snapshots the prior
  round's verdict to `wiki_draft_rounds.ai_check_results` so reviewers can
  compare across rounds.
- **Unified diff view** in the reviewer banner using `jsdiff`. New “Diff”
  tab (default) renders unified ± lines with word-level highlighting for
  changed lines and collapses long unchanged runs. Edit drafts only —
  create drafts have nothing to diff against.
- **AI check panel** appended below the diff/preview area. Collapsed shows
  a one-line summary chip + tally; expanded lists every warn / fail check
  with layer, message, and up to 5 example matches.
- **`propose_wiki_create` (REST + MCP)** lets any contributor propose a
  brand-new wiki page. The draft carries the suggested
  `{slug, title, page_type, knowledge_type_slugs, scope_type, scope_id}`;
  the parent page is materialised at approve time.
- **`create_wiki_page` (REST + MCP)** lets workspace editors and global
  `wiki:write:all` holders create pages directly without going through
  review.
- **Reviewer-side metadata overrides** on approve — `final_slug`,
  `final_title`, `final_page_type`, `final_knowledge_type_slugs` —
  applied when materialising a create draft. Slug collisions surface as
  HTTP 409 with a clear hint.
- **Polling for AI status** in the draft banner: while
  `ai_check_status ∈ {pending, running}` the component polls the draft
  every 3 seconds and refreshes the panel.

### Changed

- `WikiPageDraft.page_id` is now nullable — create drafts have no parent
  page until approval materialises one.
- `_can_review_draft` replaces page-keyed reviewer checks across all
  draft endpoints so create drafts route correctly to global / workspace
  reviewers without requiring an existing page.
- The `arkon-edit` skill documents the create flow + AI pre-review +
  `pii-allow` markers; `arkon-review` documents AI verdicts and metadata
  overrides on create-draft approval.

### Migrations

- `025_ai_pre_review_and_create_drafts.py` — adds
  `ai_check_status` / `ai_check_results` / `ai_checked_at` to
  `wiki_page_drafts`; adds `ai_check_results` to `wiki_draft_rounds`;
  adds `draft_kind` and `suggested_metadata` to `wiki_page_drafts`;
  makes `wiki_page_drafts.page_id` nullable.

### Deferred to 0.7

- Gap-driven page-creation suggestions (mining `mcp_query_log` zero-result
  searches for topics worth seeding pages from).
- Email / webhook notification channels (in-app only for now).
- Bulk-approve UI and a dedicated queue page.
- Trust / reputation signals and expertise-based reviewer routing.

---

## [0.5.0] — 2026-05-19

Contribute / review hardening, foundation pass. Adds a closed feedback loop
between authors and reviewers (`needs_revision`), an in-app notification
inbox, and a unified service for contribution state transitions across wiki
drafts and skill contributions. Lays the backbone for the upcoming AI
pre-review, diff view, and `propose_create_page` work in the next release.

### Added

- **`needs_revision` state for wiki drafts and skill contributions**: a
  reviewer can now send a draft back with a note instead of being forced to
  approve or reject. The author resubmits on the same draft —
  `revision_round` increments and the prior submission is snapshotted to
  the new `wiki_draft_rounds` table so reviewers can diff between rounds.
- **`withdraw` action for authors**: an in-flight draft (pending or
  needs_revision) can be retracted by its author without a reviewer touch.
- **`ContributionService` (`app/services/contribution_service.py`)**:
  thin state-machine wrapper with `WikiDraftAdapter` and
  `SkillContributionAdapter`. Each lifecycle verb fires audit logs and
  notifications uniformly so REST and MCP entry points behave the same.
- **`NotificationService` + in-app inbox**: new `notifications` table,
  `NotificationService` writer (sync DB inserts, audit_service pattern),
  REST endpoints `GET /notifications`, `GET /notifications/unread-count`,
  `POST /notifications/{id}/read`, `POST /notifications/read-all`.
- **NotificationBell in the header**: badge + slide-in drawer with
  mark-as-read controls; polls unread count every 30s.
- **MCP tools for the new lifecycle**:
  `request_changes_on_draft`, `resubmit_draft`, `withdraw_draft`. The
  matching skills (`arkon-edit`, `arkon-review`) document the new flow.
- **REST endpoints for wiki draft lifecycle**:
  `POST /wiki/drafts/{id}/request-changes`,
  `PATCH /wiki/drafts/{id}/content` (author resubmit),
  `POST /wiki/drafts/{id}/withdraw`,
  `GET /wiki/drafts/{id}/rounds` (per-round history).
- **REST endpoints for skill contribution lifecycle**:
  `POST /skill-contributions/{id}/request-changes`,
  `POST /skill-contributions/{id}/resubmit`,
  `POST /skill-contributions/{id}/withdraw`.
- **WikiDraftBanner UX**: distinct palette + headline for
  `needs_revision` vs `pending`, a “Request changes” button alongside
  Approve / Reject, the reviewer’s return note surfaced inline, a
  20-character minimum on rejection / request-changes notes, conflict
  badge when `base_version < page.version`, and a round counter when
  the draft has been through revisions.

### Changed

- **Skill contribution file edits no longer silently demote PENDING to
  DRAFT.** Contributors must explicitly `withdraw` (or wait for a reviewer
  to `request_changes`) before editing files on a contribution that is in
  front of a reviewer. This closes the “draft moves underfoot mid-review”
  hole flagged in the contribute/review code review.
- **Notifications fire on every lifecycle event** — submit, approve,
  reject, request_changes, resubmit, withdraw — across both REST and MCP
  entry points.

### Migrations

- `024_contribution_lifecycle.py`: adds `revision_round` /
  `last_returned_note` to `wiki_page_drafts` and `skill_contributions`,
  creates `wiki_draft_rounds` (per-round snapshots) and `notifications`
  (recipient-keyed inbox with `(recipient_id, read_at)` index for the
  badge query).

---

## [0.4.0] — 2026-05-18

A scope-aware refresh of the Wiki UX. Every wiki page already lived in a
scope (`global`, `department`, `project`), but the UI treated same-slug
pages from different scopes as duplicates and the index page only ever
showed the global catalog. This release threads scope context through
the URL, the page tree, the page detail view, and the ingestion pipeline.

### Added

- **Scope switcher on `/wiki`**: a dropdown listing the scopes the
  current user can access. Selecting a scope updates the URL
  (`/wiki?scope_type=&scope_id=`), refetches the matching `_index`
  catalog and pages grid, and is shareable / reloadable.
- **Scope-grouped page tree**: the sidebar in `/wiki` and the detail
  viewer now groups pages by scope (`GLOBAL`, plus each department),
  then by page type (`Entities`, `Concepts`, `Topics`, `Sources`).
  Clicking a scope header opens that scope's wiki landing; the chevron
  toggles expansion independently. The active scope and the bucket
  containing the active page auto-expand on navigation.
- **Scope-preserving navigation**: backlinks, outlinks, and inline
  `[[wikilinks]]` carry the current page's scope params, so jumping
  between related pages keeps the user inside the same scope context.
  The detail back button returns to `/wiki?scope_type=&scope_id=` for
  department-scoped pages (projects continue to return to
  `/workspaces`).
- **`GET /api/wiki/my-scopes`**: lists global plus each department and
  project the requester can read. Used by the scope switcher.
- **`scope_name` in wiki responses**: `/api/wiki/pages` joins the
  `Project` and `Department` tables so each summary carries a
  human-readable scope name (e.g. `"Phòng Nhân sự"`) alongside the raw
  ID, removing the need for separate lookups on the client.
- **Thematic-section concept pages during ingestion**: the MRP
  extraction and planning prompts now recognise documents that describe
  a primary entity through several distinct themes (e.g. *Product
  Positioning*, *Target Customer Profile*, *Content Pillars*) and emit
  a separate `concept` page per theme instead of dumping the content
  into the entity page. The entity page links out to them with
  `[[concept/...]]`.

### Changed

- `/api/wiki/pages` and `/api/wiki/index` accept optional
  `scope_type` + `scope_id` query parameters. When omitted the original
  behaviour is preserved (RBAC-filtered list, global index).
- `ScopeBadge` accepts `scopeId: string | null` to match the relaxed
  `WikiPageSummary` type.
- Sidebar collapse/expand chevrons swapped for `left_panel_close` /
  `left_panel_open` icons that don't look like a Back button.
- The `/wiki` page tree no longer surfaces project-scoped pages —
  workspaces remain reachable from `/workspaces` and from the scope
  switcher, keeping the wiki sidebar focused on enterprise-wide
  knowledge.
- The wiki graph no longer draws the dashed convex-hull boundaries
  around department and project clusters; nodes and edges stand on
  their own.
- The `Wiki` button previously added to department cards was removed
  once the scope switcher and clickable tree scope headers landed —
  redundant entry points were creating clutter.

### Fixed

- Department-scoped detail pages no longer fetch
  `/api/projects/<id>/wiki` (which 404s on department IDs); the tree
  uses the new general scope-aware `/api/wiki/pages` endpoint instead.
- Clicking a backlink, outlink, or inline `[[wikilink]]` from a scoped
  page used to drop scope context and load the flat "old" tree.
- Navigating to a global wiki page used to render with the legacy flat
  tree while `/wiki` showed the new grouped tree.
- `DELETE /api/wiki/pages/<slug>` returned 404 for workspace pages
  because the endpoint looked them up with the default global scope.
  Even after that lookup was fixed, the cascade helper re-fetched the
  row with the same default and silently no-op'd the actual delete,
  returning `{"ok": true}` while the row remained in the database.
  `delete_page_cascade` now takes the resolved `WikiPage` object so
  no second lookup is performed.
- The summary block under the page title piped `page.summary` straight
  into ReactMarkdown without the `[[wikilink]]` preprocessing step
  used by the main content renderer, so users saw raw `[[Arkon]]` and
  bare `**...**` markers in the header of every page. Wikilinks now
  resolve through the same preprocessor and inherit the active scope.

### Backend

- Frontend `WikiPageSummary` and Pydantic `WikiPageSummary` both gain
  `scope_name: Optional[str]`; new shared `WikiScope` type for the
  switcher payload.
- `_build_wiki_scope_filter` is reused by both `/wiki/pages` and the
  new `/wiki/my-scopes` endpoint.
- `regenerate_index` is called with the deleted page's actual scope so
  the right `_index` is rebuilt after a non-global delete.

---

## [0.3.1] — 2026-05-14

### Added

- **Wiki Graph — Department Clustering**: Wiki pages scoped to a department now visually group into department clusters on the `/wiki/graph` canvas.
  - Convex hull drawn per department (below project hulls) with a distinct color per department.
  - Force simulation biases nodes toward their department's X-zone (70% scope pull, 30% component spread) so related pages naturally converge.
  - Legend lists each department with icon `business` and page count.
  - Tooltip shows department name for dept-scoped pages.

### Fixed

- Graph endpoint now joins the `Department` table so `scope_name` is populated for department-scoped pages (previously only `Project` was joined, leaving dept nodes without a name label).

---

## [0.3.0] — 2026-05-13

### Added

- **Department-level Wiki Isolation**: Wiki pages compiled from department-scoped sources are now restricted to members of that department.
  - `ScopeType.DEPARTMENT` added to the enum; pipeline `_resolve_wiki_scopes()` resolves project > department(s) > global, fanning out multi-department sources into one page per department scope (LLM runs once, content is duplicated to each scope).
  - `wiki_service._scope_filter_with_dept()` provides a single-query OR filter (global + user's department).
  - `get_wiki_page` returns HTTP 403 for cross-department access.
  - Source PATCH: changing department on a `ready` source triggers wiki detach, old-scope index regeneration, and MRP re-queue automatically.
  - Frontend: edit-source dialog warns before department reassignment triggers re-analysis.

- **MRP Pipeline — Plan Regeneration with Reviewer Feedback**: Admin can now reject a pending plan with a note, triggering LLM-based regeneration that incorporates the feedback.
  - `POST /sources/{id}/plan/regenerate` runs in the background via `regenerate_plan_task`.
  - Plan Review Dialog surfaces a *Regenerate* button that requires a reviewer note.
  - `_resolve_maybe_items` uses LLM to decide UPDATE vs CREATE (previously always downgraded MAYBE to CREATE).

- **Catalog-driven LLM & Vision Selection**: Replaces free-form `llm_provider + llm_model_id` config with curated catalogs (`LLMModelSpec`, `VisionModelSpec`) that expose context window size, tool support, vision capability, and per-token cost.
  - `/api/settings/{llm,vision}/{catalog,switch}` endpoints mirror the embedding catalog pattern.
  - Settings UI renders a `ModelCatalogCard` per capability with metadata (context window, costs, tool/vision badges).
  - `writer._get_source_context_budget` reads `context_window_tokens` from the spec — the stale hard-coded table is removed.

- **Gemini Model Updates**: Catalog updated with newer Gemini variants.
  - `gemini-3.1-flash-lite`: 1M context, tools + vision + thinking, cheapest Google 1M option ($0.25 in / $1.50 out per 1M tokens). New recommended default for high-volume extraction and captioning.
  - `gemini-3-flash-preview` and two additional preview models added.
  - Admins on `gemini-3.1-flash` must reselect in Settings (model removed from catalog).

### Fixed

- **MRP Pipeline Hardening** (critical):
  - Draft results (`PageWriteResult`) now persisted in `plan_json._page_drafts`; VERIFY/COMMIT phases resume without re-running REFINE.
  - `caption_images_task` is now serialized before `ingest_map_reduce_task`, baking captions into `source.full_text` before MAP runs — fixes the race condition that produced empty image markers in compiled wiki pages.
  - KB reconciliation searches every destination scope and retains the best semantic match, preventing duplicate pages when the same concept exists across scopes.

- **MRP Pipeline Hardening** (high):
  - `assemble_evidence` uses word-boundary regex (`\bterm\b`) instead of substring matching, so short entity names (e.g. "AI") no longer match unrelated subjects ("MAIL").
  - `/sources/{id}/plan/regenerate` runs async via arq; UI polls `GET /plan` instead of holding an open HTTP connection.
  - JSON fence stripping unified via `parse_json_loose`; removes several incorrect `str.strip("```json")` variants in mapper and wiki_analyzer.

- **MRP Pipeline Hardening** (medium):
  - Approve/reject/regenerate endpoints use `SELECT FOR UPDATE` and reject mismatched status to prevent race conditions.

---

## [0.2.x] — prior releases

See git log.
