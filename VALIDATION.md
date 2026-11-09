# Validation record

Target: public `@opencode/plugin` / `@opencode/client` **2.2.6**, installed
OpenCode **2.2.6**. No earlier coordination plugin was inspected or reused.

## Implemented decisions

- [x] Four Code Mode tools under the provisional `linklet` namespace.
- [x] Independent session creation, no native subagent replacement.
- [x] Fresh cross-agent approval when the current agent pair is not covered by
  an established channel (user decision).
- [x] Revocation through explicit host deny rules, no extra MVP tool (user decision).
- [x] Host-owned, project-scoped approval UX; no plugin approval database.
- [x] Same-instance connection verification instead of unverified service discovery.
- [x] Bounded discovery (20 default / 100 maximum), explicit pagination, opaque
  host cursor scope checks, archived sessions always excluded.
- [x] 64 KiB logical UTF-8 body limit and 68 KiB framed-text limit.
- [x] Synthetic adapter boundary reusable for initial assignments and messages.
- [x] Conditional tab-menu UI deferred because no matching public GUI extension exists.

## Automated contract coverage

`npm run check` covers policy truth tables, canonical ID/display-name selection,
destination defaults, generic wildcard versus deliberate grants, denial
precedence, channels across reloads/concurrent writes/agent changes, tool schemas,
fresh roots, optional tasks/worktrees, destination selection, known/uncertain
failures, retained resources, exact message whitespace/UTF-8 budgets, receipt
semantics/no retries, forged prefix isolation, discovery bounds/archival/activity,
cursor-scope protection, parent/creator guidance without own ID, native tool
before/after/permission hooks, foreground-child mid-task replies, native result
preservation, and an alternative transport test double with unchanged logical
identity/body/intent/authorization.

Implementation validation on 2026-11-08: **78 contract tests passed**, including
type-check/build; both checkout-build and freshly packed/installed-package host
smoke suites passed against OpenCode 2.2.6.

Review regressions cover native continuations switching agents (including a
rejected switch), cancellation during destination lookup/approval, cancellation
after worktree/session creation, cancellation before initial task admission,
signal forwarding to resource APIs, and uncertain completion of an aborted
in-flight resource operation. Known resources remain retained without retries.
The wording audit adds coverage for all approval questions, every tool parameter's
help, connection/setup remedies, malformed page tokens, and plain-language
message rejection/uncertainty. Live agent-use observations are recorded in
`DOGFOODING.md`.

The approved discovery/output follow-up covers execution-only timestamps, strict
timezone-aware cutoffs, older ongoing executions, unknown/blocked activity,
root/sibling parentage, pagination across sparse filtered pages, short tokens
bound to all filters and sibling caller identity, bounded scans, no empty final
page, one global activity snapshot per search, typed output schemas, and readable
UI text for all four tools. The live 24-hour sibling query also returned actual
execution timestamps without an API fallback or JSON parsing.
Review coverage also checks that an execution start/end during or after retrieval
of the shared activity snapshot yields unknown, rather than a stale running/idle
inference.
Message-label coverage checks resolved sender/recipient titles, ID fallbacks only
for untitled sessions, multiline titles, renames, initial assignments, adapter
replacement, preserved reply IDs, and ID-free routine receipt text. Display titles
do not affect policy; cancellation during an outgoing progress update still stops
the message from being sent.

## Real-host smoke coverage

`npm run test:host` exercises a separately spawned, authenticated OpenCode server
and the built production JavaScript through an excluded test-only RPC harness:

- [x] Public tool registration and idle independent creation.
- [x] Canonical caller `plan` / destination display names `Plan` and `Build`.
- [x] Real cross-agent approve-once prompt despite host wildcard defaults.
- [x] Real always-allow approval reused for a different recipient.
- [x] Two-way channels and follow-ups after plugin/location reload.
- [x] Exact whitespace, CRLF, Unicode, and a 64 KiB UTF-8 body at admission.
- [x] FYI leaves an idle session inactive.
- [x] Known-ID cross-project messaging without discovery approval.
- [x] Channel storage visible from a second project's plugin instance.
- [x] Explicit send denials defeat established channels.
- [x] Session discovery without transcript exposure.
- [x] Native root/sibling filters through the public host list API.
- [x] Creation/title changes are not misreported as recent execution.
- [x] Short-token pagination has no duplicates or phantom final page.
- [x] Structured results and separate readable text from every tool.
- [x] Full server-restart persistence.

Native registry reads can initially be empty while a destination location boots.
Location-aware public HTTP agent/model reads are used so the destination's plugins
are active before selection/validation. Optional fields are omitted rather than
sent as explicit `undefined`, which native runtime schema validation rejects.

## Outstanding host integration checks

These are not silently replaced with stronger plugin-side scheduling behavior:

- [ ] Model-backed steering/queue wake semantics during active execution, pending
  FYI versus later human prompts, and active/idle admission races.
- [ ] End-to-end native foreground/background subagent execution/result delivery
  with an actual model. Supported hooks are contract-tested; the native executor
  is never replaced.
- [ ] Public read access to plugin-transformed default-agent selection. Configured
  defaults/fallbacks are implemented; use an explicit agent with plugins that
  change the registry default.
- [ ] Host GUI session-tab context-menu extension, if introduced later.

`npm run test:package` packs and installs into a separate temporary directory,
checks that the test RPC harness is excluded, and repeats the smoke suite with
`LINKLET_VALIDATION_ENTRY` pointing to the installed package's `dist/index.js`.
Neither script publishes or alters the live service.
