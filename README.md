# mails-agent-mcp

MCP (Model Context Protocol) Server that gives any MCP-compatible AI agent
receive-first email capabilities via [mails-agent](https://mails0.com), with
send and account-management tools available after a permanent mailbox claim.

## Install

Requires Node.js 20 or newer.

```bash
npm install -g mails-agent-mcp
```

## Zero-config first run

No mailbox is required before the MCP server starts. Call `get_inbox`,
`wait_for_code`, or any other tool; the server automatically creates a random
72-hour receive-only mailbox, stores the API key in `~/.mails/config.json` with
`0600` permissions, and never returns the key to the model.

The provisional mailbox can receive, read, search, and extract verification
codes. It cannot send, download attachments, manage domains/webhooks, or create
additional mailboxes. Claim a permanent mailbox at
[mails0.com](https://mails0.com) to upgrade.

`create_temporary_mailbox` remains available when the agent needs to create or
inspect the temporary mailbox explicitly.

## Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mails-agent": {
      "command": "mails-agent-mcp"
    }
  }
}
```

## Configure Cursor

Add to your Cursor MCP settings (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "mails-agent": {
      "command": "mails-agent-mcp"
    }
  }
}
```

## Tools

### create_temporary_mailbox

Create or reuse an expiring receive-only mailbox without browser approval.
Returns the mailbox, expiry, and capabilities, but never the API key.

### send_email

Send an email from your mailbox.

| Parameter | Type   | Required | Description              |
|-----------|--------|----------|--------------------------|
| to        | string | yes      | Recipient email address  |
| subject   | string | yes      | Email subject line       |
| body      | string | yes      | Plain text email body    |
| html      | string | no       | Optional HTML email body |

### get_inbox

List recent emails in your mailbox.

| Parameter | Type   | Required | Description                                              |
|-----------|--------|----------|----------------------------------------------------------|
| limit     | number | no       | Max emails to return (default 20)                        |
| query     | string | no       | Search query to filter emails                            |
| direction | string | no       | "inbound" or "outbound"                                  |
| label     | string | no       | Filter by label: newsletter, notification, code, personal |
| mode      | enum   | no       | Search mode: "keyword" (FTS5), "semantic" (vector), "hybrid" (both). Default: "keyword" |

### search_inbox

Search emails by keyword, semantic similarity, or hybrid.

| Parameter | Type   | Required | Description                                              |
|-----------|--------|----------|----------------------------------------------------------|
| query     | string | yes      | Search query keyword                                     |
| limit     | number | no       | Max results to return (default 20)                       |
| label     | string | no       | Filter by label: newsletter, notification, code, personal |
| mode      | enum   | no       | Search mode: "keyword" (FTS5), "semantic" (vector), "hybrid" (both). Default: "keyword" |

### get_email

Get full details of a specific email by ID.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| id        | string | yes      | Email ID    |

### wait_for_code

Wait for a verification code email to arrive. Polls until a code is received or timeout is reached.

| Parameter | Type   | Required | Description                                                          |
|-----------|--------|----------|----------------------------------------------------------------------|
| timeout   | number | no       | Max seconds to wait (default 30)                                     |
| since     | string | no       | Only return codes received after this ISO timestamp (e.g. 2026-03-27T10:00:00Z) |

### delete_email

Delete an email by ID.

| Parameter | Type   | Required | Description        |
|-----------|--------|----------|--------------------|
| id        | string | yes      | Email ID to delete |

### get_attachment

Download an attachment by its ID. Returns text content inline for text-based files, or metadata for binary files.

| Parameter | Type   | Required | Description   |
|-----------|--------|----------|---------------|
| id        | string | yes      | Attachment ID |

### get_threads

List email threads in your mailbox.

| Parameter | Type   | Required | Description                          |
|-----------|--------|----------|--------------------------------------|
| limit     | number | no       | Max threads to return (default 20)   |

### get_thread

Get all emails in a specific thread.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| id        | string | yes      | Thread ID   |

### extract_data

Extract structured data from an email (order, shipping, calendar, receipt, code).

| Parameter | Type   | Required | Description                                              |
|-----------|--------|----------|----------------------------------------------------------|
| email_id  | string | yes      | Email ID to extract data from                            |
| type      | enum   | yes      | Type of data: order, shipping, calendar, receipt, code   |

## How It Works

The MCP server reads `~/.mails/config.json` and also supports the documented
`MAILS_API_URL`, `MAILS_API_KEY`, `MAILS_MAILBOX`, and `MAILS_WORKER_TOKEN`
environment variables. It supports hosted mode (`api_key` with `/v1/*`
endpoints) and self-hosted mode (`worker_token` with `/api/*` endpoints).

## Ecosystem

| Project | Description |
|---|---|
| [mails](https://github.com/Digidai/mails) | Email server (Worker) + CLI + TypeScript SDK |
| [mails-agent-mcp](https://github.com/Digidai/mails-mcp) (this repo) | MCP Server for AI agents |
| [mails-agent (Python)](https://github.com/Digidai/mails-python) | Python SDK |
| [mails-skills](https://github.com/Digidai/mails-skills) | Skill files for AI agents |

## License

MIT
