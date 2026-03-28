# mails-agent-mcp

MCP (Model Context Protocol) Server that gives any MCP-compatible AI agent full email capabilities via [mails-agent](https://mails0.com).

## Install

```bash
npm install -g mails-agent-mcp
```

## Prerequisites

You need a configured mails-agent mailbox (`~/.mails/config.json`):

```bash
npm install -g mails-agent
mails claim yourname          # claims yourname@mails0.com
```

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

| Parameter | Type   | Required | Description                       |
|-----------|--------|----------|-----------------------------------|
| limit     | number | no       | Max emails to return (default 20) |
| query     | string | no       | Search query to filter emails     |
| direction | string | no       | "inbound" or "outbound"           |

### search_inbox

Search emails by keyword.

| Parameter | Type   | Required | Description                         |
|-----------|--------|----------|-------------------------------------|
| query     | string | yes      | Search query keyword                |
| limit     | number | no       | Max results to return (default 20)  |

### get_email

Get full details of a specific email by ID.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| id        | string | yes      | Email ID    |

### wait_for_code

Wait for a verification code email to arrive. Polls until a code is received or timeout is reached.

| Parameter | Type   | Required | Description                             |
|-----------|--------|----------|-----------------------------------------|
| timeout   | number | no       | Max seconds to wait (default 30)        |

### delete_email

Delete an email by ID.

| Parameter | Type   | Required | Description        |
|-----------|--------|----------|--------------------|
| id        | string | yes      | Email ID to delete |

## How It Works

The MCP server reads your mails-agent config from `~/.mails/config.json` and makes authenticated API calls to the mails-agent Worker API. It supports both hosted mode (`api_key` with `/v1/*` endpoints) and self-hosted mode (`worker_token` with `/api/*` endpoints).

## License

MIT
