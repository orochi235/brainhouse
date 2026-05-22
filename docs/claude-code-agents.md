# Claude Code built-in agent types

Reference list of subagent types ("agentType") that the Claude Code harness
exposes out of the box. Useful for brainhouse if/when we want to group,
filter, or badge panels by agent type — these are the strings that land on
subagent panels via the `agentType` field in `.meta.json`.

User-installed custom agents (anything under `~/.claude/agents/` or a
project's `.claude/agents/`) sit alongside these and use whatever name the
user gave them.

| agentType | Tools | What it's for | Icon candidate |
|---|---|---|---|
| `claude` | `*` | Default catch-all. Used when no specific agent name is provided. | Claude star / logomark |
| `claude-code-guide` | Bash, Read, WebFetch, WebSearch | Answers questions about Claude Code itself — the CLI, hooks, slash commands, MCP, the Agent SDK, and the Anthropic API. | Open book |
| `code-simplifier:code-simplifier` | All tools | Simplifies / refines recently modified code for clarity and consistency while preserving behavior. | Pruning shears |
| `Explore` | All read-only tools (no Edit/Write/NotebookEdit/ExitPlanMode/Agent) | Fast read-only search agent. Best for "where is X defined", "which files reference Y", file-pattern lookups, keyword greps. Reads excerpts, not whole files — bad at whole-file audits or cross-file consistency checks. | Pith helmet |
| `general-purpose` | `*` | General-purpose multi-step research / search / task execution. Default when you want to delegate but no more specific agent fits. | Swiss Army knife |
| `Plan` | All read-only tools | Architect agent. Produces step-by-step implementation plans, identifies critical files, weighs trade-offs. Doesn't write code itself. | Drafting compass |
| `statusline-setup` | Read, Edit | Configures the user's Claude Code status line in settings.json. | Gear |

## Notes for brainhouse

- The subagent panel's `agent_type` field is populated from the
  sidecar `.meta.json` (`agentType`) when present. For built-ins this
  matches the table above verbatim, so equality checks are safe.
- The plugin-namespaced form (`code-simplifier:code-simplifier`) is the
  full identifier — the `<plugin>:<name>` shape will repeat for any
  third-party agents installed via plugins.
- This list reflects what's available in the current harness build; it
  may drift as Claude Code adds or removes built-ins. Treat it as
  documentation of what we've observed, not a closed enum.
- The "Icon candidate" column captures design intent only — concept
  shapes, not a sourced asset set. Picking a library (or commissioning
  custom marks) is still open.
