# Linklet

Create separate **OpenCode V2 2.2.6** sessions and exchange messages with them.
New sessions start without the creator's conversation history and can continue
independently. For self-contained delegated tasks, prefer OpenCode's native
`subagent` tool and its automatic result delivery.

This is an unpublished MVP implementation of [`SPEC.md`](SPEC.md). The package
is private to avoid accidentally reserving/publishing the provisional name.

## Install locally

```sh
npm ci
npm run check
```

Add this checkout to the desired OpenCode configuration (global configuration
makes coordination available across projects):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-linklet"],
}
```

Build after source changes with `npm run build`. OpenCode reloads changed plugin
files/configuration; `/reload` can force a reload. No service restart is needed
for installation. Do not install `test/host-plugin`: it is an isolated test
harness, not part of the published package.

If this session runs on OpenCode's shared managed service, no connection options
are needed. Linklet finds that service, uses its authentication, and checks that
it is the same process running the plugin. Linklet never starts another server
or silently connects to a different one.

If you start OpenCode with `opencode serve` or `--standalone`, specify the URL of
the server running your session—not the URL of a separate managed service:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/absolute/path/to/opencode-linklet",
    "options": {
      "server": {
        "url": "http://127.0.0.1:4096",
        "usernameEnv": "OPENCODE_SERVER_USERNAME",
        "passwordEnv": "OPENCODE_SERVER_PASSWORD",
      },
    },
  }],
}
```

Omit credential fields for an unauthenticated server. `passwordEnv` selects Basic
authentication (username defaults to `opencode`); alternatively `tokenEnv`
selects Bearer authentication. Credentials are read from the server process's
environment, never stored by Linklet. No credentials belong in the URL.
An explicit URL selects one server. If you use several servers with the same
global configuration, each needs a configuration that points to its own instance;
Linklet rejects a connection to the wrong one.

## Four tools

Discovery and creation are in the `linklet` Code Mode namespace.
Sending is exposed directly as `linklet_send_message`, so outgoing messages have
their own tool entry rather than an `execute` wrapper. Effective host IDs:

| Tool | Inputs and behavior |
| --- | --- |
| `linklet_find_projects` | Optional `all`, `search`, `limit`, `offset`. Defaults to this project. Returns registered projects and saved checkouts, including projects without sessions; `nextOffset` continues the result. |
| `linklet_find_sessions` | Optional `project`, `all`, `search`, `relationship`, `activeSince`, `limit`, `cursor`, or `sessionID` lookup. Defaults to this project; returns metadata, parent/creator relationships, activity, and known execution timestamps—not conversation content. |
| `linklet_create_session` | Optional `project`, `checkout`, `title`, `agent`, `model`, `worktree`, `task`. Creates a separate session, not a child or a copy of this conversation. Returns without waiting for task completion. Omit task to leave it idle. |
| `linklet_send_message` | Required `sessionID`, `text`; optional `delivery`: `steer` (default), `queue`, `fyi`. Exactly one explicit recipient; complete body, no aliases or broadcasting. |

Search pages default to 20 items, maximum 100. Projects match exact IDs/canonical
paths first, then case-insensitive name/path tokens. Ambiguous project selections
return candidates rather than guessing. Agent selection accepts an exact
agent ID first, then an exact unique display name. Independent sessions need a
visible agent that supports primary sessions, such as Build or Plan—not a
subagent-only agent. Models use `{ providerID, id, variant? }` and
must be available at the destination; use native model-discovery tools.

### Recent sessions, roots, and siblings

`find_sessions` supports:

- `relationship: "all"` (default): include independent sessions and native children.
- `relationship: "roots"`: include sessions without a native parent.
- `relationship: "siblings"`: other sessions with this session's native parent.
  For an independent/root caller, this means other roots. The caller is excluded;
  having the same creator does not make sessions siblings. Project scope still applies.
- `activeSince`: an ISO 8601 timestamp with a timezone. Include sessions with a
  known execution start/end on or after that cutoff, plus sessions currently
  running (even if their execution started earlier). Unknown execution times
  alone do not match; old blocked sessions are not assumed to be doing work now.

Each result includes `lastExecutionAt` when OpenCode reports an execution start or
end. It is a UTC timestamp for the latest of those two boundaries—not the time of
the most recent model/tool step. Creation, title changes, viewing, and generic
metadata updates are deliberately ignored. A missing timestamp means unknown,
not “never ran.” Current activity is reported separately.

Results also include `commitSHA`, the current HEAD of the session's checkout,
when available. It describes checkout state, not a commit owned by that session.
Linklet reads each distinct returned directory once per call, with a two-second
timeout per Git query. Missing/non-Git directories and unborn HEADs omit the
field. No dirty-state scan, fetch, or merge analysis is performed.

For example, in Code Mode:

```js
const result = await tools.linklet.find_sessions({
  relationship: "siblings",
  activeSince: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
});
return result.sessions;
```

Discovery and creation return **structured objects** in Code Mode, not JSON strings.
Use `await tools.linklet.find_sessions(...)` directly; remove any surrounding
`JSON.parse`. The direct send tool also declares a structured result schema.
Human-facing tool rows retain readable text with useful IDs/paths.

Continue session searches by copying `nextCursor` into `cursor`, keeping
`project`/`all`, `search`, `relationship`, and `activeSince` unchanged. Sibling
searches must continue from the same caller session. Page size may change.
Tokens are 24 characters, and ordinary final pages have `nextCursor: null`.
To keep large searches bounded, a call examines at most 1,000 candidates;
`scanLimitReached: true` means continue with the returned cursor to check more,
not that another matching session is guaranteed. Tokens issued before this
update must be replaced by starting a new search; stored channels are unaffected.

Without `project`, creation uses the caller's **actual session directory**.
An explicit project uses its canonical checkout unless `checkout` names one of
its existing checkouts. `checkout` without `project` is rejected. Only supplying
`worktree: { name?: "task" }` creates a worktree, using the host's configured
strategy and destination. Nothing selects branches or deletes resources.

Omitted agent/model selections follow destination configuration, not the caller's
selections. Destination agent defaults follow the documented configured-default,
Build, then visible primary fallback. See the validation caveat below about
other plugins changing the registry default.

### Delivery and results

| Delivery | Host mapping | Meaning |
| --- | --- | --- |
| `steer` | `steer`, `resume: true` | Next model step; wake idle recipient. |
| `queue` | `queue`, `resume: true` | After current work; wake idle recipient. |
| `fyi` | `steer`, `resume: false` | Next model step if running; do not wake idle recipient. |

Messages are not guaranteed to be read in the order they were sent. FYI does not
wake an idle session, but a later human prompt can cause it to be read. Steering
or human input may be read before an older queued message.

The message limit is **65,536 UTF-8 bytes**, plus a **69,632-byte** total limit
including the sender label. Oversize messages fail without being truncated or
split. All whitespace inside the message is preserved. Linklet takes the sender
ID from the session running the tool, not from a field the caller can fill in or
from text inside the message. The label helps recipients reply; it does not give
peer messages the authority of human instructions. Copied labels or metadata
are not proof of a sender's identity.

Compact incoming descriptions and outgoing progress labels use the corresponding
session's title. They fall back to its session ID only if no readable title is
available, so untitled sessions remain identifiable. Routine receipt text does
not repeat opaque IDs. The reply ID also remains in the agent-facing message and
structured results where it is needed to address a reply. Titles are for display
only and never determine permissions or channel identity.

`admitted` means **OpenCode accepted the message**. It may still be waiting: this
does not confirm that the recipient read it, started work, or completed a task.
`uncertain` means Linklet could not tell whether the message was accepted or a
session/worktree was created. **Do not automatically repeat the request**: that
could send a duplicate message or create another session/worktree. Linklet keeps
known resources and returns their IDs/paths when available.

Stopping the tool call prevents further creation and initial-task submission.
An already-created session is kept idle, and any created worktree is kept. If
cancellation happens during a creation request and its result is unknown, Linklet
reports `uncertain` rather than retrying.

Independent sessions do not forward final responses automatically. Ask them to
message results/failures if needed. For native children, give the assignment in
the native subagent call and rely on native final-result delivery. Avoid duplicate
results, receipt-only acknowledgements, and routine status polling.

## Permissions and durable channels

| Action | Default behavior |
| --- | --- |
| `linklet.find_projects`, `linklet.find_sessions` | List projects or look up session details. This project's details are allowed by default; configured restrictions still apply. Conversation history is never included. |
| `linklet.create_session`, `linklet.send_message` | Creation and messaging can be allowed or denied separately. Message rules can name a recipient session ID. |
| `linklet.cross_project_discovery` | Additional approval to look up other projects or their sessions. |
| `linklet.cross_project_creation` | Separate additional approval to create a session in another project. |
| `linklet.cross_agent` | Additional approval to create or message a session with a different agent ID, unless the recipient uses `plan` or an established reply relationship covers the pair. Uses `*` as its resource; the approval is not saved per recipient. |

Cross-project boundaries use project IDs when resolved, the supplied selector
for ambiguous/unknown selections, and `*` for all-project discovery. Known-ID
messaging requires **no cross-project discovery/creation approval**.

OpenCode's usual defaults allow most tools. Linklet still asks before looking
outside this project, creating a session in another project, or communicating
across agent IDs when the exceptions above do not apply. A broad `*` allow rule
does not skip these additional questions. To approve them in advance, use rules
that name the relevant Linklet action, or `linklet.*` to cover all Linklet actions.

OpenCode's **Allow always** choice saves approval for the current project, not
for every project. Linklet uses those saved approvals; it does not keep a
separate approval database. Configured denials and OpenCode policies still win.

Creating a session, or successfully submitting a message, establishes a **channel**:
the two sessions can reply or follow up without another cross-agent approval.
Other tool permissions still apply. Linklet remembers this relationship across
restarts and reloads, including for native subagents without changing their
execution or result delivery. The record covers both session IDs **and their
current agent IDs**; a pair not covered by the record needs fresh approval.
It does not grant conversation-history access or new execution permissions.

Revoke access using host deny rules; no fifth channel-management tool is added:

```jsonc
{
  "permissions": [
    { "action": "linklet.send_message", "resource": "ses_recipient", "effect": "deny" },
  ],
}
```

There is no automatic import/migration of another plugin's channels, approvals,
stored history, or message prefixes. Remove an older coordination plugin from
your configuration yourself if replacing it. Native subagents remain unchanged.

## Implementation and validation

- `src/policy.ts`: canonical identity policy, agent selection, durable channels.
- `src/transport.ts`: logical peer input, synthetic encoding, receipts, localized
  compatibility guidance. A future native provenance adapter replaces this
  boundary, not tool contracts/policy. The native adapter in tests is a test
  double, not an invented production API.
- `src/linklet.ts`: public-host operations, authorization, discovery, creation.
- `src/discovery.ts`: recent-execution timestamps, cutoff validation, and search bounds.
- `src/results.ts`: structured result schemas and readable tool-row summaries.
- `src/connection.ts`: authenticated, same-instance public client connection.
- `src/index.ts`: four tools, context guidance, and native subagent hooks.

```sh
npm run check       # type-check, contract tests, production build
npm run test:host   # opt-in isolated real OpenCode 2.2.6 server validation
npm run test:package # pack/install in isolation, then validate the installed build
```

Host validation uses a separate HOME/XDG tree under `/tmp/opencode`, never the
user's live configuration, service, or sessions. It makes no model requests and
retains its artifacts/logs for inspection. See [`VALIDATION.md`](VALIDATION.md)
for verified behavior and remaining integration checks.

**Deliberate limits:** exact host/SDK version pin; no transcript/history tools,
custom inbox/broker, interrupt, archive discovery, automatic forwarding, or
replacement viewer. The public GUI API has no session-tab context-menu extension,
so the optional “Copy session ID” convenience is deferred, not replaced with a
different UI.

Some plugins change the default agent through `editor.default`, but OpenCode does
not expose that choice through its public read API. If you use one of those
plugins, pass `agent` explicitly. Normal configured defaults and primary-agent
fallbacks are supported. If OpenCode returns a different agent than Linklet
checked, Linklet keeps the new session idle instead of sending its task.

Delivery ordering during active work and full native background execution still
need model-backed integration tests; the contract tests do not prove those
scheduler guarantees. See `DOGFOODING.md` for the live workflows already exercised.

`npm audit` currently reports moderate transitive advisories in the pinned
OpenCode SDK dependency tree. No high/critical advisories were reported during
implementation; do not force dependency overrides without compatibility testing.
