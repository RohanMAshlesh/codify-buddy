# Team mode: admin guide

Team mode adds one server to Codify Buddy. Engineers sign in with company
SSO, and from then on the CLI and the VS Code extension:

- send model traffic through your **gateway**, so the Anthropic key stays on
  the server;
- follow your **policy**: maximum permission mode, allowed models, allowed
  MCP servers;
- search **shared sources** (Confluence, Jira, GitHub, doc folders), synced
  once on the server and filtered by each person's groups;
- record an **audit log** and count spend against **monthly budgets**.

Nothing changes for engineers beyond signing in once.

## 1. Configure

```bash
codify team init team.json --org Acme
```

```jsonc
{
  "org": "Acme",
  "dataDir": "./codify-team-data",            // tokens, usage, audit, indexes
  "oidc": {                                   // omit for token-only setups
    "issuer": "https://acme.okta.com/oauth2/default",
    "clientId": "codify-cli",
    "groupsClaim": "groups"
  },
  "admins": ["platform-lead@acme.com"],
  "adminGroups": ["platform"],
  "sessionHours": 168,
  "policy": {
    "maxPermissionMode": "auto-edit",         // read-only | ask | auto-edit | yolo
    "allowedModels": ["claude-opus-5-5", "claude-sonnet-5-5"],   // [] = any
    "allowedMcpServers": "*",                 // "*" | ["files", …] | []
    "requireGateway": true,                   // all model traffic via the server
    "monthlyBudgetUsd": 200,                  // per person; 0 = unlimited
    "budgetWarnAt": 0.8,
    "auditPrompts": false                     // metadata only by default
  },
  "gateway": { "upstream": "https://api.anthropic.com", "apiKeyEnv": "ANTHROPIC_API_KEY" },
  "sources": [
    { "id": "eng-wiki", "type": "confluence", "baseUrl": "https://acme.atlassian.net/wiki",
      "email": "svc-codify@acme.com", "spaces": ["ENG"], "allow": ["group:engineering"] },
    { "id": "pay-jira", "type": "jira", "baseUrl": "https://acme.atlassian.net",
      "email": "svc-codify@acme.com", "jql": "project = PAY AND updated >= -180d", "allow": ["group:payments"] }
  ],
  "syncIntervalMinutes": 60
}
```

**Source access (`allow`).** Each entry is `*` (everyone signed in),
`group:<name>`, `user:<email>` or `domain:<acme.com>`. An empty list means
admins only. Mirror each source's own permissions: for example, a Confluence
space readable by the `engineering` group gets `group:engineering`.

**Connector tokens.** Sources use a service account. Put its tokens in the
server's environment (`CONFLUENCE_API_TOKEN`, `JIRA_API_TOKEN`,
`GITHUB_TOKEN`) or in the server user's `~/.codify/credentials.json`.

## 2. Register an SSO app

Create a **public / native** OIDC application in your identity provider:

| Setting | Value |
|---|---|
| Grant type | Authorization code with PKCE (no client secret) |
| Redirect URI | `http://127.0.0.1/callback` (loopback; most providers accept any port for loopback redirects, per RFC 8252) |
| Scopes | `openid email profile` |
| Groups claim | Include group names in the ID token as `groups` (or set `groupsClaim`) |

Okta, Microsoft Entra ID, Google Workspace, Auth0 and Keycloak all support
this. Without SSO, issue tokens instead (step 4).

## 3. Run the server

```bash
ANTHROPIC_API_KEY=sk-ant-… codify team serve --config team.json --port 8787 --host 0.0.0.0
```

Or with Docker (see the `Dockerfile` at the repo root):

```bash
docker build -t codify-team .
sudo chown -R 1000:1000 team        # the container runs as the unprivileged "node" user
docker run -p 8787:8787 -v $PWD/team:/data -e ANTHROPIC_API_KEY=sk-ant-… codify-team
```

`team/` holds `team.json`. The data directory is created next to it.

Put it behind your usual TLS reverse proxy (nginx, an ALB, Cloud Run) and give
engineers the HTTPS URL. One server process owns the data directory, so run a
single instance (state is file-backed; a database store is on the roadmap).

## 4. Engineers sign in

```bash
codify login --team https://codify.acme.com     # opens the SSO page
codify team status                              # policy, budget, visible sources
```

For CI, or orgs without SSO:

```bash
codify team token create -c team.json --email ci@acme.com --groups engineering --label ci --days 90
# then in CI: CODIFY_TEAM_URL=https://codify.acme.com CODIFY_TEAM_TOKEN=cbt_…
```

## 5. Operate

| Task | Command |
|---|---|
| Sync sources now | `codify team sync -c team.json [source]` |
| Spend this month | `codify team usage -c team.json [--month 2026-11]` |
| Audit log | `codify team audit -c team.json [--email …] [--type tool_call] [--since 2026-11-01]` |
| List / revoke tokens | `codify team token list` · `codify team token revoke <id>` |

Admins can also read the audit log, usage and tokens over the API (for
example, to feed a SIEM): `GET /v1/admin/audit`, `/v1/admin/usage`,
`/v1/admin/tokens`, `POST /v1/admin/sync`.

## What is enforced where

| Control | Enforced by | Notes |
|---|---|---|
| Allowed models | **Server** (gateway rejects) and client (switches with a notice) | |
| Monthly budget | **Server** (gateway rejects at 100%) and client (checks before each turn, warns at 80%) | Metered from the actual token usage in each response |
| Source access | **Server** (search and document routes filter by group) | Documents a user can't see never leave the server |
| Org API key | **Server** | Engineers never receive it |
| Max permission mode | Client (the gate caps every mode change) | The gateway can't see local file edits; pair with `requireGateway` so only managed clients get model access |
| Allowed MCP servers | Client (blocked servers are never started) | |
| Audit of tool calls | Client sends, server stores under the caller's identity | Clients can't spoof the user; model requests are logged by the server itself |

## What the audit log contains

`sign_in`, `turn_start` (model, prompt length; the prompt text only with
`auditPrompts: true`), `tool_call` (tool and description, such as a command
or file path), `tool_result` (ok, denied), `notice` (warnings and errors),
`turn_end` (stop reason, tokens) and `model_request` (model, tokens, cost,
recorded by the gateway). File contents and model answers are never logged.
