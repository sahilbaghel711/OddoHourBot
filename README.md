# OddoHourBot

An MCP (Model Context Protocol) server that lets an AI agent (e.g. GitHub Copilot) fill your Odoo timesheets automatically from Azure DevOps work items.

---

## How it works

```
GitHub Copilot Agent
       │
       ├─ ADO MCP  ──► reads your assigned work items / sprints
       │
       └─ odoo-hours MCP  ──► writes timesheet lines to Odoo
```

The included `.github/prompts/log-hours.prompt.md` prompt ties everything together: just tell Copilot "log my hours for today" and it will:

1. Figure out the working days in the requested range
2. Check what's already logged in Odoo
3. Fetch your active ADO stories and tasks
4. Estimate hour coverage, create missing ADO tasks if needed
5. Write all timesheet lines to Odoo idempotently

---

## Prerequisites

- Node.js ≥ 18
- An Odoo instance with timesheet access
- An Azure DevOps organisation with a Personal Access Token (PAT)
- VS Code with the GitHub Copilot extension (for the agent prompt)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/sahilbaghel711/OddoHourBot.git
cd OddoHourBot
npm install
```

### 2. Create the `.env` file

Copy the template below to a file called `.env` in the project root.  
**Never commit this file** — it is already in `.gitignore`.

```dotenv
# ── Odoo ───────────────────────────────────────────────
ODOO_BASE_URL=https://<your-instance>.odoo.com
ODOO_LOGIN=you@yourcompany.com
ODOO_PASSWORD=your_odoo_password

# Find your UID: Settings → Users → open your profile → check the URL (?id=XXX)
ODOO_UID=730

ODOO_COMPANY_ID=3          # Settings → Companies → your company ID
ODOO_TZ=Asia/Calcutta      # Your timezone (IANA format)
ODOO_LANG=en_US
ODOO_CIDS=3                # Usually same as ODOO_COMPANY_ID

# Default Odoo project used when no project is specified in an entry
ODOO_DEFAULT_PROJECT=PCA Track 2 - PCA

# ── Azure DevOps ───────────────────────────────────────
ADO_ORG=your-ado-org
ADO_PROJECT=YourProject

# Create a PAT at: https://dev.azure.com/<org>/_usersSettings/tokens
# Required scopes: Work Items (Read & Write), Code (Read)
ADO_PAT=your_ado_pat_here

# Optional: restrict WIQL queries to a specific sprint / area
ADO_ITERATION_PATH=YourProject\Sprint Name
ADO_AREA_PATH=YourProject\Your Team
```

### 3. Configure `config.json`

`config.json` maps **project display names** to their internal Odoo IDs.  
Add an entry for every project you log hours against:

```json
{
  "My Project Name": {
    "project_id": 12345,
    "account_id": 67890,
    "lead_id": 111,
    "child_opp_name": "My Project Name",
    "company_id": 3,
    "employee_id": 629,
    "story_search_mode": "direct_under_project",
    "task_search_mode": "under_story"
  }
}
```

| Field | Description |
|-------|-------------|
| `project_id` | Odoo internal project ID |
| `account_id` | Odoo analytic account ID |
| `lead_id` | Odoo CRM lead / opportunity ID |
| `child_opp_name` | Name of the child opportunity in Odoo |
| `company_id` | Odoo company ID |
| `employee_id` | Your Odoo employee ID |
| `story_search_mode` | `direct_under_project` or `id_in_list_only` |
| `story_ids` | Required when mode is `id_in_list_only` — list of Odoo task IDs |
| `task_search_mode` | `under_story` or `none` |

### 4. Configure the MCP servers in VS Code

Create `.vscode/mcp.json` (this file is in `.gitignore` — do not commit it):

```json
{
  "servers": {
    "odoo-hours": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/mcp-server.js"]
    },
    "ado": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@azure-devops/mcp",
        "<your-ado-org>",
        "--authentication", "pat",
        "-d", "core", "work", "work-items"
      ],
      "env": {
        "PERSONAL_ACCESS_TOKEN": "${env:ADO_PAT}"
      }
    }
  }
}
```

> `${env:ADO_PAT}` reads the value from your system environment variable `ADO_PAT`.  
> Set it in your shell profile (`$PROFILE` on PowerShell, `~/.bashrc` on bash) so VS Code inherits it:
>
> ```powershell
> # PowerShell profile ($PROFILE)
> $env:ADO_PAT = "your_ado_pat_here"
> ```

---

## MCP Tools (exposed to the AI agent)

| Tool | Description |
|------|-------------|
| `fill_hours` | Log an array of timesheet entries directly to Odoo (idempotent — creates or updates) |
| `fill_hours_from_file` | Same as above but reads entries from a JSON file on disk (defaults to `entries.json`) |
| `get_logged_hours` | Return all timesheet lines already logged in Odoo for a date range, grouped by date |
| `check_holidays` | Fetch public holidays from Odoo for a date range |

### `fill_hours` — entry shape

```json
{
  "date": "2026-04-27",
  "project": "PCA Track 2 - PCA",
  "story": "Risk Register - Live Collaborator POC",
  "task": "basic setup - ui",
  "hours": 2
}
```

`task` is optional; omit it to log directly against the story.

---

## Using the AI agent prompt

The file `.github/prompts/log-hours.prompt.md` is a Copilot agent prompt.

1. Open the Copilot Chat panel in VS Code
2. Click the paperclip / attach icon and select **Prompt**
3. Choose **Log Hours from ADO**
4. Type a date or range, e.g.: `today`, `2026-04-28`, `2026-04-21 to 2026-04-25`

The agent will guide you through any PTOs, show a capacity table, create missing ADO tasks if needed, and fill all hours.

---

## Standalone scripts

### `bot.js` — direct Odoo filler

Reads `entries.json` and posts directly to Odoo without MCP:

```bash
npm run fill
```

`entries.json` format (array of entry objects — same shape as `fill_hours` above).

### `fetch-ado.js` — ADO task fetcher

Queries ADO and writes a list of your current tasks to `entries.from.ado.json`:

```bash
node fetch-ado.js
```

Configure the scope via `.env` variables (`ADO_ITERATION_PATH`, `ADO_AREA_PATH`).

---

## Security notes

- `.env` and `.vscode/` are in `.gitignore` — never remove those entries
- Rotate your ADO PAT regularly and never paste it directly into any committed file
- `entries.json` is also gitignored as it may contain personal work data
