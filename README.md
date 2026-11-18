# Display & Video 360 MCP Server

A local [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude (and other MCP clients) read **Google Display & Video 360** data: campaign metadata from the Display & Video 360 API and performance reports from the Bid Manager API. Ask "how did campaign X of advertiser Y do last week?" and get the campaign's status, flight, and budget together with its numbers in one answer.

It runs on your machine, started by your MCP client over stdio, and calls Google with **your own Google login**. It is **read-only towards DV360**: it never creates, changes, or deletes campaigns, insertion orders, line items, or saved reports. The only things it writes are its own temporary report queries (titled `[MCP] …`), which it deletes again after seven days.

## Tools

| Tool | What it does |
|---|---|
| **Combined** | |
| `get_performance` | Answers "how is this advertiser / campaign / insertion order / line item doing" in one call: finds the entity by name or ID, shows its status, flight, and budget, runs a report for it, and returns the rows. Metric presets: `delivery` (default), `video`, `viewability`, `conversions`, `youtube`, `reach`. Breakdowns: total, day, week, month, or a level below the target. Default dates: the last 7 days. If a name matches several entities, nothing is run and the candidates are listed. |
| `find_entities` | Finds partners, advertisers, campaigns, insertion orders, or line items by name (case-insensitive, exact matches first) and returns their IDs. |
| **Campaign metadata** (Display & Video 360 API) | |
| `list_partners` | Partners your account can see. The starting point when no IDs are known. |
| `list_advertisers` | Advertisers under one partner. |
| `list_campaigns` | Campaigns of an advertiser (status, goal, planned dates and spend). |
| `list_insertion_orders` | Insertion orders of an advertiser or campaign (budget, current budget segment, pacing). |
| `list_line_items` | Line items of an advertiser, campaign, or insertion order (type, flight, budget, bid strategy). |
| `get_metadata` | One entity in detail: a readable summary plus Google's full record. |
| **Reporting** (Bid Manager API) | |
| `list_report_fields` | The dimensions, filters, and metrics each report type (`STANDARD`, `YOUTUBE`, `REACH`) accepts. Local, no Google call. |
| `run_report` | Starts a custom report and returns a ticket at once. |
| `run_saved_report` | Runs one of your saved reports for a new date range, without changing it. |
| `get_report` | Collects a report: a link to the full file (XLSX or CSV) and a paged preview of its rows. |
| `list_saved_reports` | Your account's saved reports. |
| **Other** | |
| `health` | Confirms the server is running and reports its version. No Google call. |

Money is reported as **Revenue (advertiser currency)**: what the advertiser is billed. Report links are Google's signed download links, valid for about four months; anyone with a link can open that report.

## Quick start

You need Node.js 24 or newer, the Google Cloud CLI (`gcloud`), and a Google account with access to DV360.

### 1. Set up Google access (once)

1. **A Google Cloud project.** Use an existing one or create one. Its ID is your *quota project*: Google counts API usage against it. Your account needs permission to use it (Owner, Editor, or Service Usage Consumer).
2. **Enable the two APIs:**
   ```sh
   gcloud services enable doubleclickbidmanager.googleapis.com displayvideo.googleapis.com --project <project-id>
   ```
3. **An OAuth consent screen** (Google Cloud console → Google Auth Platform). Choose **Internal** if your account is in a Google Workspace organisation; otherwise **External**, and add yourself as a test user. With External in *Testing* mode, the login expires after 7 days and you log in again.
4. **An OAuth client** of type **Desktop app** (Google Auth Platform → Clients → Create client). Download its JSON file and keep it outside this repository, for example in `~/.config/dv360-mcp/oauth-client.json`.
5. **Log in** with the DV360 account, using that client and the scopes the server needs:
   ```sh
   gcloud auth application-default login \
     --client-id-file=$HOME/.config/dv360-mcp/oauth-client.json \
     --scopes=https://www.googleapis.com/auth/doubleclickbidmanager,https://www.googleapis.com/auth/display-video,https://www.googleapis.com/auth/cloud-platform
   ```
   This writes Application Default Credentials to `~/.config/gcloud/application_default_credentials.json`. The server finds them there. To use a different file, set `GOOGLE_APPLICATION_CREDENTIALS` to its path.

The account sees in the server exactly what it sees in DV360: it needs a DV360 role on the partners or advertisers you want to ask about.

### 2. Build the server

```sh
git clone https://github.com/UnverOnal/display-video-360-mcp-server.git
cd display-video-360-mcp-server
npm ci
npm run build
```

### 3. Add it to your MCP client

**Claude Code:**

```sh
claude mcp add dv360 --scope user \
  -e GOOGLE_CLOUD_QUOTA_PROJECT=<project-id> \
  -- node /absolute/path/to/display-video-360-mcp-server/dist/index.js
```

**Claude Desktop** (Settings → Developer → Edit Config, then restart the app):

```json
{
  "mcpServers": {
    "dv360": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/display-video-360-mcp-server/dist/index.js"],
      "env": { "GOOGLE_CLOUD_QUOTA_PROJECT": "<project-id>" }
    }
  }
}
```

Use the full path of `node` (`which node`): Claude Desktop does not always see your shell's `PATH`. Other MCP clients that start stdio servers work the same way: command `node`, argument `dist/index.js`, and the environment variable.

Then ask, for example: "List my DV360 partners", or "How did advertiser X do last week?"

### Configuration

| Variable | Required | Meaning |
|---|---|---|
| `GOOGLE_CLOUD_QUOTA_PROJECT` | yes | Cloud project charged for the Google API quota. The server will not start without it. |
| `GOOGLE_APPLICATION_CREDENTIALS` | no | Path to an `authorized_user` credentials file; otherwise Application Default Credentials are used. |

If a tool reports that the Google login has expired, run the login command in step 1.5 again. No restart is needed.

## How it works

- **stdio transport.** The client starts the server as a child process and talks MCP over stdin/stdout. Diagnostics and one JSON log line per tool call and Google request go to stderr (Claude Desktop keeps them in its MCP log files). Logs never contain tokens, IDs, names, or report links.
- **One Google identity.** Both APIs are called with the OAuth user credentials from your login; one login carries both scopes.
- **Start, then collect.** Reports can take a while, so `run_report` returns a ticket and `get_report` collects it; `get_performance` waits up to 20 seconds and otherwise returns a ticket.
- **Reliability:** bounded retries that never repeat a report start, a Bid Manager request pacer and daily-limit latch, and per-call time budgets.

Code guide: [`docs/architecture.md`](docs/architecture.md). Decisions and their reasons: [`docs/decisions.md`](docs/decisions.md). Verified API behaviour: [`docs/api-reference.md`](docs/api-reference.md).

## Customizing

Fork it and change what you need. The places most people touch:

| What | Where |
|---|---|
| Metric presets of `get_performance` (for example media cost instead of revenue) | `src/combined/presets.ts` |
| Default date range and breakdowns | `src/combined/performance.ts`, `src/tools/performance.ts` |
| Tool descriptions (what Claude reads about each tool) | The description strings in `src/tools/*.ts`. Tests assert them exactly, so update the matching `*.test.ts`. |
| Report title prefix `[MCP]` and the 7-day cleanup | `src/integrations/bidmanager/titles.ts` |
| Report fields offered per report type | `src/integrations/bidmanager/fields.ts`. Add a field only after a report using it finished (`DONE`) live; see [`docs/code/bidmanager-fields.md`](docs/code/bidmanager-fields.md). |
| A new tool | [`docs/code/startup-and-stdio.md`](docs/code/startup-and-stdio.md#adding-a-tool) |

`npm run typecheck` and `npm test` (about 1,300 offline tests, no network) tell you whether a change broke something. See [`docs/code/testing.md`](docs/code/testing.md).

### Running it remotely

This repository is local-only on purpose. To host it for a team (an HTTP transport, sign-in, a container), put that code in a fork under `src/remote/`: build the services with `createRuntime` from `src/runtime.ts` and call `createMcpServer()` per request or per session. `src/remote/` is skipped by the boundary tests, so your additions don't need changes to the shared code, and updates from this repository merge cleanly. Remote hosting needs real authorization in front of it: everyone who can reach the server acts as its Google account.

## Limitations

- Read-only towards DV360; no campaign changes.
- One Google identity per server process, and the Bid Manager quota (about 2,000 requests a day per project).
- Name search is "contains", not fuzzy; campaign, insertion order, and line item names are searched within their advertiser.
- Report fields are limited to the ones verified live (see [`docs/code/bidmanager-fields.md`](docs/code/bidmanager-fields.md)).

## License

[MIT](LICENSE)
