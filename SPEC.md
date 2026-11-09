# Linklet — working specification

**Purpose:** lightweight coordination between independent OpenCode V2 sessions,
while retaining native subagents for bounded child tasks.

**Status:** agreed MVP behavior with feasibility checks still outstanding; not
yet a finalized implementation handoff. Linklet is the provisional name.
Package/repository names and exact tool schemas are not finalized or reserved.
`opencode-linklet` appeared unpublished on npm on 2026-11-08; plain `linklet`
has a previously unpublished package record.

## 1. Design and handoff boundary

Implement from these requirements and public OpenCode V2 APIs. Do not copy the
earlier plugin's code, internal architecture, helpers, or prompt wording, or
require the implementation agent to inspect it. This is design/implementation
separation, not a claim of legally certified cleanroom provenance.

Keep policy and tool contracts independent of OpenCode's message representation.
In particular, synthetic user-turn framing is a replaceable compatibility
mechanism, not Linklet's permanent message protocol (§6).

## 2. MVP tools and scope

Session discovery includes optional `commitSHA`: the current checkout HEAD,
not session-owned work or merge readiness. Read each distinct returned directory
once per call; omit unavailable values. Do not scan dirty state or fetch refs.

Four focused tools; names below describe capabilities, not final API spellings:

| Tool | Responsibility |
|---|---|
| Find projects | Discover registered projects and available checkouts, including projects with no sessions. |
| Find sessions | Search/list sessions or look up one by ID; include metadata and activity status. |
| Create session | Create a persistent independent session, optionally in a new worktree and/or with an initial task. |
| Send message | Deliver complete text to exactly one session ID. |

Keep OpenCode's built-in `subagent` tool for child tasks: foreground waits for
the native result; background returns immediately and later notifies the parent.
Do not replace that execution/result mechanism. Linklet-created sessions are
always independent, fresh-context, and asynchronous; creation never waits for
task completion. Messaging can reach either kind of session.

**Not in MVP:** conversation-history reading; inbox inspection/cancellation;
standalone status, blocking wait, or completion-subscription tools; self-archive
or include-archived discovery; broadcast/multicast; interrupt delivery; custom
branch-selection/worktree-cleanup tools; automatic result forwarding; custom
received-message viewers. No automatic tab-opening requirement.

## 3. Permissions and communication channels

Use canonical agent IDs, not display names, models, or inferred write capability.
For creation or initiating contact with an existing session:

| Situation | Additional cross-agent-type approval |
|---|---|
| Same agent ID | Not required |
| Destination agent ID is `plan` | Not required |
| Different agent IDs otherwise | Ask unless preauthorized or covered by an established channel |

Examples: `plan` → `build` asks; `build` → `plan` and `build` → `build` do not.
This is an intentional identity-based policy, not proof that a customized Plan
agent is read-only. Normal tool permissions, policies, destination execution
permissions, and host agent-eligibility restrictions still apply.

- Creation and messaging are independently permissionable capabilities.
- Messaging any known session ID is allowed by default, even across projects
  and regardless of how the ID was learned, subject to the table above and
  explicit restrictions. No additional cross-project messaging approval.
- Same-project discovery is allowed by default. Cross-project discovery and
  cross-project creation have separate permissions, each **ask by default**.
- Use OpenCode's approve-once/always-allow UX where supported. Keep the
  cross-agent-type grant simple, without per-recipient rules. Do not build a
  separate approval database or assume always-allow is global: host approvals
  have their own scope.
- An authorized creation establishes a two-way creator/session channel,
  including independent roots. A received message also establishes a two-way
  channel with its sender. Replies/ordinary follow-ups require no new
  cross-agent-type or generic channel approval, even across agent types/projects.
- Channels survive restarts/reloads. Explicit denials still win; channels
  confer neither transcript access nor new execution rights. Do not classify
  free-form message intent to decide whether communication is permitted.
- Verify actual prompts despite OpenCode's default wildcard grants. Validate
  coverage of built-in subagent calls through supported hooks, without replacing
  the built-in tool. Mechanism and channel behavior after agent changes remain
  open (§10); do not silently add a new policy.

## 4. Persistent creation

### Placement and initial state

- Always fresh context: no transcript copying or forking.
- Optional initial task: admit asynchronously when present; otherwise create
  an idle session without starting a model turn.
- Optional title: use normal host behavior when omitted, without promising
  immediate title generation for idle sessions. Encourage useful idle titles.
- No destination override: use the caller's actual current directory.
- Explicit destination project: accept an existing checkout; if omitted, use
  that project's canonical checkout. Cross-project creation is supported and
  permission-gated.
- Create a new worktree only when requested, including for idle sessions and
  destination projects. Use OpenCode's configured strategy/destination and an
  optional name; leave branch selection and cleanup to existing host tools.
- Distinguish creator identity from actual parentage. Independent sessions do
  not become children merely because another session created them.

### Agent and model selection

- Overrides are optional. When omitted, use the destination location's
  effective defaults, not the caller's selections. Configuration may combine
  global and location/project settings; verify exact host default resolution.
- Accept an exact agent ID or unambiguous display name from the destination's
  actual agent listing. Exact IDs take precedence; pass the canonical ID to
  host APIs. Unknown/ambiguous selections return valid choices, never guesses.
- Default IDs `build`/`plan` have display names Build/Plan and are primary
  agents, not built-in subagent choices. Validate location-specific availability
  and eligibility. Test caller-agent lookup as well as destination selection;
  capitalization alone is not an established fix for prior lookup failures.
- Model overrides use exact provider/model IDs and optional variant, not display
  names. Reuse existing model-discovery tools. Reject invalid/unavailable
  overrides rather than silently substituting.

### Failure handling

Validate selections and permissions before resource creation where possible.
On later failure, retain sessions/worktrees, report known IDs/paths and what
remains, and distinguish known failure from uncertain completion after timeout.
Never blindly retry creation or delete resources as rollback. Task admission
does not establish successful startup, task completion, or correctness.

## 5. Discovery and activity

- Project discovery returns stable IDs, useful names/paths, and checkouts.
  Support requests such as “create a session in the hollow sphere project and
  tell it to implement XYZ” without requiring the human to supply identifiers.
  Discover candidates and ask when multiple plausible matches remain.
- Session discovery defaults to the caller's project. Authorized cross-project
  searches may name a project or span all projects. Knowing a project first is
  not required. Explicit session-ID lookup also supplies activity status.
- Include independent and built-in subagent sessions. Return title, session ID,
  project, directory, and known parent/creator relationships; do not invent
  unknown creator information or expose conversation content.
- Always exclude archived sessions; no include-archived option.
- Activity: `running`, `blocked`, `idle`, or `unknown`. Include a blocking reason
  when available, e.g. permission approval or requested input. Missing data is
  not proof of idle/unblocked. No last-execution-outcome field in MVP.
- Idle means not executing, not successful completion. Discovery/possession of
  an ID grants no transcript access or execution authority.

## 6. Messaging and replaceable provenance integration

### Stable behavior

- Unicast to an explicit session ID only; no parent/creator aliases.
- Preserve the complete caller-supplied body and whitespace. Reject over-limit
  input clearly; never truncate or automatically split it. Establish supported
  limits during host validation, including framing overhead.
- No agent-managed request/idempotency IDs. Retry internally only when the host
  supports doing so safely; otherwise report ambiguous delivery as **uncertain**,
  without automatically retrying or claiming definite failure.
- Derive sender identity from tool execution context, not a caller-supplied
  sender field. Recipients receive a replyable sender session ID and readable
  attribution that distinguishes peer input from human instructions.
- Context guidance supplies known parent/creator IDs, distinguishing the two,
  but omits the agent's own session ID. Caller identity is already available to
  the plugin. Persistent-session results are explicitly messaged when requested.

### Delivery

| Linklet mode | Intended behavior | Current synthetic API mapping to verify |
|---|---|---|
| Steer — default | Next model step; wake if idle | `delivery: "steer", resume: true` |
| Queue | After current work; wake if idle | `delivery: "queue", resume: true` |
| FYI | Next model step if running; do not wake if idle | `delivery: "steer", resume: false` |

FYI does not strictly hold input until a future run. Current inspected host
behavior prioritizes steering inputs over queued inputs, can batch steers, and
promotes queued inputs individually. A later human steering prompt may overtake
older queued input. Test pending FYIs with human prompts and active/idle races;
do not promise atomic ordering. Defer expensive scheduling changes or a separate
durable delivery system beyond MVP. There is no interrupt mode.

### Compatibility boundary: synthetic input now, native provenance later

Keep a small host-integration boundary that accepts **body, resolved sender and
recipient identity, and delivery intent**, independently of wire formatting.
Policy, channel records, creation, and agent-facing tools must not depend on a
particular prefix, provider role, or synthetic metadata layout. Use this same
boundary for messages and agent-origin initial assignments.

The initial adapter uses public `ctx.session.synthetic` (§9). It owns:

1. Temporary peer-attribution framing around an otherwise unchanged body, since
   synthetic text currently reaches the model as user-role input. Write original
   Linklet wording; no exact legacy prefix is required.
2. A compact readable `description` using the resolved sender session title.
   Fall back to its session ID only when no readable title is available. Titles
   are display-only; keep reply IDs in agent-facing text/metadata as well.
   Include namespaced, versioned sender metadata.
   Metadata alone must not be assumed to reach the model as provenance.
3. Delivery/wake mapping, admission receipts, and uncertain transport errors.
4. Compatibility context guidance explaining peer attribution. Keep this wording
   localized rather than scattering prefix assumptions through tools/prompts.

Keep logical body and attribution separate before encoding. Never recover
authorization/channel identity by parsing arbitrary text that resembles a
prefix, and do not describe declared metadata as authenticated identity.

When OpenCode offers native message provenance, replace the adapter's encoding
and associated compatibility guidance, not Linklet's tool API or permission
model. Check actual host support/version; do not invent a future API signature.
Do not rewrite stored history or reinterpret old prefixes as trusted origin.
Add contract tests showing legacy and future adapters preserve identical logical
bodies, sender/reply identity, delivery intent, and authorization behavior, with
no duplicate attribution when native support is used. No general transport
framework, custom broker, or native provenance implementation is needed for MVP.

## 7. Agent guidance and human-facing UI

- Prefer native subagents for bounded tasks; give the assignment initially and
  use native final-result delivery. Avoid duplicate result messages, receipt-only
  acknowledgements, routine progress requests, and redundant instructions.
  Mid-task corrections, blockers, and useful asynchronous coordination remain
  appropriate.
- Persistent sessions do not automatically forward final responses. Instruct
  them to message results/failures when requested; no wait/subscription tool.
- Received-message expansion belongs to OpenCode, not a replacement plugin
  viewer. Preserve complete bodies/descriptions and adapt to host improvements.
  See the filed OpenCode issues in §11.
- Include a lightweight readable outgoing-send summary/description if supported
  simply; do not assume synthetic descriptions customize tool-call rows.
- Desired conditional MVP convenience: **Copy session ID** in a tab's context
  menu, copying the clicked tab's ID even if inactive. Defer if it needs
  substantial host/frontend work; do not silently substitute a different UI.

## 8. Persistence

Use public host-managed storage and native relationships where sufficient.
Channels must survive restarts/reloads and work across projects. No separate
database, direct host SQL/table access, or dependence on OpenCode's internal
database schema. Any plugin-owned records should be small and versioned.

## 9. Public OpenCode API references

References checked 2026-11-08. Verify the chosen host/SDK version before building;
documentation and local declarations are not proof of running-server behavior.

| Need | Public API / reference |
|---|---|
| Register focused tools | `Plugin.define`, `ctx.tool.transform`, `editor.add`, tool permission options — [server tools](https://opencode.ai/v2/docs/build/plugins/server#tools) |
| Caller/target identity and creation | `ctx.session.get({ sessionID })`; `ctx.session.create({ location, title?, agent?, model?, metadata? })`, without `parentID` — [sessions](https://opencode.ai/v2/docs/build/plugins/server#sessions) |
| Durable peer input | `ctx.session.synthetic({ sessionID, text, description?, metadata?, delivery?, resume?, id? })` → admitted synthetic inbox item; HTTP `POST /api/session/{sessionID}/synthetic` — [sessions](https://opencode.ai/v2/docs/build/plugins/server#sessions), [API reference](https://opencode.ai/v2/docs/api) |
| Context guidance | `ctx.session.hook("context", ...)` — [model-request hooks](https://opencode.ai/v2/docs/build/plugins/server#model-requests); instruction entries are another public facility, not a required migration |
| Native child work | Built-in `subagent`, including `background` and continuation via `sessionID` — [tools](https://opencode.ai/v2/docs/tools#subagent) |
| Discovery | Public client `project.list`, `session.list`; native `ctx.session.list` where exposed — [client](https://opencode.ai/v2/docs/build/client), [API reference](https://opencode.ai/v2/docs/api) |
| Checkouts/worktrees | `ctx.worktree.list({ projectID })`, `ctx.worktree.create({ projectID, from?, name? })` — [worktrees](https://opencode.ai/v2/docs/build/plugins/server#worktrees) |
| Agent/model validation | `ctx.agent.list/get` with applicable location, `ctx.model.list/default` or public client equivalents — [agents](https://opencode.ai/v2/docs/build/plugins/server#agent), [models](https://opencode.ai/v2/docs/build/plugins/server#models) |
| Approval | `ctx.permission.assert({ sessionID, agent, source, action, resources, save, metadata? })`; supported permission/tool hooks for integration — [plugin permissions](https://opencode.ai/v2/docs/build/plugins/server#permissions), [rule/approval semantics](https://opencode.ai/v2/docs/permissions) |
| Channel persistence | `ctx.storage.get/set/remove/scan` — [storage](https://opencode.ai/v2/docs/build/plugins/server#storage) |
| Activity/blocked reasons | Public client `session.active`, `permission.request.list`, `form.list` or supported events; validate location/project scope and use unknown when unavailable — [API reference](https://opencode.ai/v2/docs/api) |

Synthetic admission is not model completion or successful startup. Its optional
host `id` is not an agent-facing Linklet argument. Synthetic input bypasses the
ordinary user-prompt admission hook; do not rely on that hook to authorize it.
Prefer native plugin capabilities. If missing APIs require a client, connect to
the actual serving instance with correct authentication/location; do not assume
a discovered managed service is the instance running the user's sessions.

## 10. Remaining decisions and implementation checks

Do not reopen settled behavior or silently expand MVP. Resolve these specifics:

1. Final tool/package names, schemas, project matching, search/pagination bounds,
   permission action/resources, and message-size limits.
2. Supported host/SDK versions; location-aware agent/default/model resolution,
   reliable activity data, and public UI extension feasibility.
3. Reliable ask/always-allow behavior despite wildcard defaults; integration
   with built-in subagent permissions; channel revocation and behavior after
   either endpoint changes agents. No capability-inference requirement.
4. Channel establishment on successful creation/admission, not ambiguous failure
   or spoofed prefix text; persistence scope, concurrency, and reload recovery.
5. Runtime validation of synthetic wake/delivery semantics, FYI ordering, partial
   failures, and safe internal retries. Avoid an independent delivery system.
6. Independent installation/migration and contract tests covering the rules
   above, including adapter replacement without agent-facing API changes.

The earlier feature inventory/agenda are discussion inputs, not additional
approved requirements. Retain deferred ideas separately rather than smuggling
them into this MVP.

## 11. Filed OpenCode issues and related host work

Status checked 2026-11-08. These are OpenCode application/API issues, not
requests to copy or extend the earlier coordination plugin.

- [#61116 — Expand synthetic updates in the web/desktop transcript](https://github.com/anomalyco/opencode/issues/61116)
  (**open**): directly relevant to showing complete received-message bodies
  beneath compact descriptions. Keep this in the host, not a Linklet viewer.
- [#61117 — Let plugins provide worktree setup command defaults](https://github.com/anomalyco/opencode/issues/61117)
  (**open**): related worktree integration, originally motivated by Chappai.
  Linklet should use normal host worktree behavior; implementing setup-command
  defaults is neither a Linklet feature nor an MVP dependency.
- [#61187 — Extensible Markdown code-block actions for GUI plugins](https://github.com/anomalyco/opencode/issues/61187)
  (**closed/completed** by merged [PR #61533](https://github.com/anomalyco/opencode/pull/61533)):
  related public GUI extensibility. This concerns fenced code blocks, not proof
  of support for custom outgoing tool-call rows or session-tab context menus.
  Check the actual API/host version rather than treating it as a solution to
  those separate UI needs.

No separately filed native agent-message provenance issue was found among the
author's OpenCode issues during this check. Native provenance remains a future
integration point (§6), not a currently promised API or filed dependency.

## 12. Approved discovery/output follow-up

Approved after the baseline implementation was committed on 2026-11-08:

- Session discovery includes optional `lastExecutionAt`: the latest known native
  execution start/end, in UTC. It must not use creation, viewed, or generic update
  times as a substitute, and does not claim to identify the latest model/tool step.
- `activeSince` accepts an explicit-timezone ISO 8601 cutoff. Match known execution
  starts/ends on or after the cutoff and sessions currently running. Unknown times
  alone do not qualify; blocked status alone is not proof of recent execution.
- `relationship` is `all` (default), `roots`, or `siblings`. Roots have no native
  parent. Siblings share the caller's native parent; an independent caller's
  siblings are other roots. Exclude the caller from sibling results. Creator
  relationships are not parentage. Existing project permissions and archival
  exclusions continue to apply.
- All four tools return schema-described objects, plus readable text
  for human tool rows. Agents should not need to parse JSON-encoded result strings.
- Session page tokens are short, opaque, and bound to the complete search scope.
  Filtering must not skip matching results at native page boundaries or falsely
  offer an ordinary empty final page. Bound scans and explicitly report when the
  caller must continue checking candidates; do not claim a partial scan is complete.

This does not add transcript access, execution-outcome reporting, extra tools,
automatic result forwarding, or a separate message-delivery system.
