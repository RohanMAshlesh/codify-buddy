# Codify Buddy for VS Code

An AI coding copilot that knows your code **and** your team's docs. It
answers with citations you can click, and it makes changes only after you
review them in VS Code's diff view.

## What you get

- **Chat in the sidebar.** Ask about the project. Codify Buddy searches the
  code and your connected sources (Confluence, GitHub issues, Jira, doc
  folders) before it answers.
- **Clickable citations.** `src/refunds.js:25` opens the file at that line.
  `@confluence/refund-policy:9-17` opens the policy page right in the editor,
  with a link to the original.
- **Reviewed edits.** Every edit shows up as a native side-by-side diff, with
  **Allow / Always allow / Deny** in the chat. Shell commands ask too.
- **Ask about a selection.** Right-click selected code and pick *Codify: Ask
  About Selection* (`Ctrl+Alt+I` / `Cmd+Alt+I`) or *Explain Selection*.
- **Search code and docs.** *Codify: Search Code and Docs* (`Ctrl+Alt+K` /
  `Cmd+Alt+K`) gives a live list of ranked snippets from both.
- **Sessions.** Resume earlier conversations from the history button.

## Getting started

1. Install the extension and open a project folder.
2. Open **Codify Buddy** from the activity bar.
3. Add your Anthropic API key when asked. It's kept in VS Code's secret
   storage and passed only to the Codify engine.

The engine is bundled, so you don't need Node.js or the `codify` CLI. To
connect Confluence, GitHub or Jira, use the CLI in the project folder
(`npx codify-buddy connect confluence`). The extension uses the same
`.codify/` index and settings.

## Settings

| Setting | Default | |
|---|---|---|
| `codify.permissionMode` | `ask` | `ask` reviews every edit and command; also `auto-edit`, `read-only`, `yolo`. Change it per session from the status bar. |
| `codify.openDiffOnApproval` | `true` | Open the diff view automatically when an edit needs approval |
| `codify.model` | *(default)* | Model id, e.g. `claude-sonnet-5-5` |
| `codify.effort` | *(default)* | Thinking effort: `low` to `max` |
| `codify.serverCommand` | *(bundled)* | Use an installed CLI instead, e.g. `codify` |

## Privacy

The index, synced documents and sessions stay in your project's `.codify/`
folder. Only the snippets the agent reads are sent to the model. Connectors
use your own tokens, so you only see what your account can access.
