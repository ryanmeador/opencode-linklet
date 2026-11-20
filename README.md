# Linklet for OpenCode

Working across several OpenCode sessions shouldn't make you their message bus.
When one session needs another's findings, a rebase, or a separate investigation,
you shouldn't have to copy instructions and results between tabs.

Linklet lets your agents **find other sessions, start independent work, and
message each other**—within a project or across projects on the same OpenCode
server. Each session keeps its own context, tools, and permissions, while you stay
in control of cross-project and cross-agent access.

Use it to:

- Have a coordinator session find related work and request updates or routine rebases.
- Start an investigation in a separate session, optionally with its own worktree,
  and continue that conversation directly.
- Let specialists exchange findings without copying entire conversations into
  each other's context.

For a short, self-contained task with an automatic result back, use OpenCode's
native **subagent** tool. Linklet is for sessions that need to continue
independently, communicate more than once, or collaborate with existing sessions.

Linklet is an independent community plugin, not an official Anomaly product.

## Installation

Requires OpenCode **>=2.2.6 <3.0.0**. Tested on **2.2.6 and 2.3.0**; other
versions in that range may work but haven't been tested.

Install from [GitHub](https://github.com/ryanmeador/opencode-linklet):

```sh
opencode plugin add github:ryanmeador/opencode-linklet
```

This adds the plugin to your global OpenCode configuration, making it available
across projects. OpenCode handles package installation and reloads the plugin.
Use `/reload` if needed.

Alternatively, add it to the `plugins` array in your global
`~/.config/opencode/opencode.jsonc` or a project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:ryanmeador/opencode-linklet"],
}
```

Preserve existing plugin entries. You can pin a release tag or full commit hash
by appending `#<tag-or-commit>` to the GitHub specification.

### If you run a standalone server

For OpenCode's managed service, no connection options are needed. If you start
your own server with `opencode serve` or `--standalone`, Linklet needs its URL
so it can connect back to **that same server**.

Linklet runs inside OpenCode, but the plugin API does not yet expose every read
it needs—for example, project discovery and saved approvals. It uses OpenCode's
HTTP API for those reads; messaging itself stays in-process.

Replace the plugin's string entry with an object like this:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "github:ryanmeador/opencode-linklet",
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

Use your server's actual URL. The credential settings name environment variables
already available to the **server process**; they do not set credentials.
Omit them for an unauthenticated server. For Bearer authentication, use `tokenEnv`
instead of `passwordEnv` and `usernameEnv`. Do not put secrets in the URL.

Linklet verifies that it reached the server hosting the session. It never starts
another server, and it cannot connect sessions on different servers.

## How it works

Linklet adds four tools your agents can use:

| Tool | What it does |
| --- | --- |
| `find_projects` | Find registered projects and their checkout directories. |
| `find_sessions` | Find sessions by title, project, relationship, or recent activity—without reading their conversations. |
| `create_session` | Start an independent session with fresh context, optionally with a worktree and an initial assignment. |
| `send_message` | Send another session a request or findings, immediately, after its current work, or as an FYI that won't wake it. |

For example, ask your agent:

> Find the other sessions that worked on this project in the last day. Ask which
> changes are ready, and coordinate rebases with them. Don't merge anything yet.

Or:

> Start a separate session in a new worktree to investigate the slow tests.
> Give it the relevant context and ask it to send its findings back.

You don't need to learn the tool parameters. Agents receive tool descriptions
and usage guidance; the [agent reference](docs/tool-reference.md) covers the
details for integrations and troubleshooting.

### What to expect

- New sessions **do not inherit the conversation**. The creating agent must
  provide the context they need.
- Replies are requested, not automatically forwarded. Native subagents keep
  their usual automatic result delivery.
- Message acceptance isn't task completion. Idle sessions aren't necessarily
  finished or ready to merge.
- Omitted agent/model choices use the destination's defaults, not the creator's
  selections.
- Linklet does not merge changes, choose branches, or clean up worktrees.

## Permissions and collaboration

Linklet asks before discovering or creating work in another project, and before
communicating across agent IDs when no exception or existing channel applies.
Creating a session or successfully sending a message establishes a durable
channel so the pair can reply without repeated cross-agent approval.

Agents are told to cooperate with reasonable peer requests, including routine
rebases, under your instructions and existing permissions. They resolve routine
questions with each other and ask you about suspicious requests, instruction
conflicts, or material scope changes. Peer messages cannot grant new authority.

OpenCode's **Allow always** applies to the current project. Explicit denials and
OpenCode policies still win. Broad wildcard defaults do not bypass Linklet's
additional approvals; deliberate rules for individual `linklet.*` actions can
preapprove them.

For example, block messages to a particular session:

```jsonc
{
  "permissions": [
    { "action": "linklet.send_message", "resource": "ses_recipient", "effect": "deny" },
  ],
}
```

## Development

Clone the repository and build with Node.js 22 or later:

```sh
git clone https://github.com/ryanmeador/opencode-linklet.git
cd opencode-linklet
npm ci
npm run check
```

For local development, configure the checkout's absolute path instead of the
GitHub package specification.

```sh
npm run test:host    # isolated validation against the installed OpenCode
npm run test:package # pack/install in isolation, then validate the installed build
```

Host tests use a separate HOME/XDG tree under `/tmp/opencode`, make no model
requests, and do not change your live service or sessions. `npm pack` builds
through `prepack`; it does not run tests.

Active delivery ordering and full native background execution still need
model-backed integration tests. See the [agent reference](docs/tool-reference.md)
for operational limits and detailed permission behavior.

## License

[MIT](LICENSE).
