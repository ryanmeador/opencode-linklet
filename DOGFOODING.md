# Live agent-use assessment — 2026-11-08

## Installation

Replaced only the global `opencode-team-plugin` configuration entry with this
local Linklet checkout. The running server hot-reloaded it: the four Linklet
tools appeared in Code Mode and the old `team` namespace disappeared. No service
restart, old-plugin deletion, or permission broadening was needed.

The first discovery calls failed safely because managed-service discovery found
a different running server. This session actually uses the standalone server at
`http://127.0.0.1:4096`. Its identity was independently verified, and the global
plugin entry now explicitly selects it, reading credentials from the server's
existing environment variables. This configuration is specific to that serving
instance; it is not a transparent multi-server solution.

## Real workflows exercised

- Same-project project/session discovery, including a native child relationship.
- Idle independent creation using destination defaults.
- FYI admission followed by session lookup: the recipient remained idle.
- Queue admission to that idle session: it woke, used Linklet tools itself, and
  sent a substantive result back, including the marker from the pending FYI.
- Creation with an initial assignment and display-name selection `Plan`.
- A Plan recipient replying to its Build creator using the established channel.
- Default steer delivery to the now-idle Plan session: it woke, retained context,
  and returned the original assignment marker.
- Cross-project project discovery and a small cross-project session search,
  without messaging any existing project sessions.
- Actual cursor continuation, not merely inspection of a returned cursor.

The two clearly labeled `Linklet live test` sessions are retained; no worktrees
were created. Both completed the requested tasks. Completion was confirmed by
their actual messages, not inferred from admission receipts or idle status.

## Agent-user findings

The core discover → create → assign → reply workflow is usable. Creator versus
parent guidance and readable peer attribution were clear to both recipients.
The four focused tool names and default delivery made the common path simple.

The following are concrete usability debts, not claims that everything is
polished:

1. **Structured results were JSON strings in Code Mode (corrected).** A single call displayed
   reasonably, but scripts composing calls needed `JSON.parse`. The actual catalog
   signatures returned `Promise<string | null>`. Tools now declare result schemas
   and return typed objects, with separate readable text for the UI.
2. **Pagination cost unnecessary effort (corrected).** Searching the two live-test sessions
   with `limit: 5` returned a 483-character cursor; following it returned an empty
   page. Tokens are now 24 characters; lookahead checks for another matching
   result before offering a next page, except when an explicit scan bound is reached.
3. **Parameter help was too dependent on long tool descriptions (corrected).**
   The abbreviated catalog cut off the main descriptions. Each input now has
   help explaining its meaning, defaults, limits, and relevant permission scope.
4. **Project matching needs better disambiguation cues.** A real project-name
   search returned two registered IDs sharing a canonical path, one with checkout
   inventory and one without. Do not silently discard either, but explain the
   difference so an agent need not guess which ID to use.
5. **Standalone connection setup is not obvious.** The safe PID check worked,
   but the normal agent workflow stalled until a human-facing serving-instance
   configuration was supplied. Document the distinction prominently; ideally the
   host would expose a same-instance client directly.

## Permission wording corrected during this assessment

The human found “the host's general wildcard grant is not preauthorization”
confusing. The approval messages now name the concrete operation instead:

- “Allow Linklet to look up projects or sessions outside this project? Conversation history is not included.”
- “Allow Linklet to create a session in another project?”
- “Allow Linklet to create or message a session that uses a different agent?”

The policy is unchanged: ordinary OpenCode default tool access does not waive
Linklet's additional cross-project/cross-agent approvals; explicit Linklet grants,
applicable saved approvals, channels, and configured denials retain their roles.

## Follow-up wording audit

Reviewed every production string in `src/`, plus the installation, delivery, and
permissions documentation. Changed approval questions (including ordinary tools
when explicitly set to ask), tool descriptions and every parameter's help,
connection/setup errors, agent/project/model selection errors, paging errors,
message-size/rejection/uncertainty messages, partial-creation and cancellation
results, outgoing-send labels, native-subagent warnings, and injected peer/context
guidance.

The copy names the operation, distinguishes accepted messages from completed
work, says what was kept after a failure, and gives a concrete next step. Terms
such as “admission,” “wire limit,” “preauthorization,” and “creator/channel
persistence” no longer appear in those explanations. Stable tool names, input
fields, status codes, limits, delivery behavior, and approval rules are unchanged.
Malformed page tokens now receive a helpful Linklet error instead of a raw JSON
parser exception. The separate JSON-result, cursor-length, and duplicate-project
issues above are not changed by this wording pass.

## Approved discovery/output follow-up

After committing the baseline, implemented feedback from another agent about
finding sibling sessions that worked in the past 24 hours. `find_sessions` now
returns `lastExecutionAt` from execution start/end metadata, accepts `activeSince`
and `relationship` filters, and scans filtered pages without discarding matches.
All four tools return structured objects; their UI text is readable prose rather
than raw JSON. The JSON-result and cursor debts above are resolved by this later
feature pass, not by the earlier wording-only audit.

The live same-project `relationship: "siblings"` / 24-hour query returned the two
completed test peers with their known execution times and no extra empty page.
The result was an object, accessed directly without `JSON.parse`. Duplicate
project disambiguation and standalone-server setup remain separate limitations.

The original feedback session subsequently verified its real inventory: the
24-hour sibling search returned the expected eight sessions in pages of 3, 3,
and 2, with no duplicates, child subagents, self, API fallback, or JSON parsing.
The final cursor was null. A root-only cross-check added exactly the caller.
