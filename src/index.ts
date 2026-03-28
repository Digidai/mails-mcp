#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface MailsConfig {
  worker_url?: string;
  worker_token?: string;
  api_key?: string;
  mailbox?: string;
  default_from?: string;
}

const CONFIG_PATH = join(homedir(), ".mails", "config.json");

function loadConfig(): MailsConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      "mails-agent not configured. Run: npm install -g mails-agent && mails claim <name>"
    );
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as MailsConfig;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

let _config: MailsConfig | null = null;

function getConfig(): MailsConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

function getBaseUrl(): string {
  const config = getConfig();
  return config.worker_url || "https://mails-worker.genedai.workers.dev";
}

function getToken(): string {
  const config = getConfig();
  const token = config.api_key || config.worker_token;
  if (!token) {
    throw new Error(
      "No API key or worker token found in ~/.mails/config.json. Run: mails claim <name>"
    );
  }
  return token;
}

function getMailbox(): string {
  const config = getConfig();
  const mailbox = config.mailbox || config.default_from;
  if (!mailbox) {
    throw new Error(
      "No mailbox configured in ~/.mails/config.json. Run: mails claim <name>"
    );
  }
  return mailbox;
}

function useV1(): boolean {
  const config = getConfig();
  return !!config.api_key;
}

async function apiCall(
  method: string,
  path: string,
  params?: Record<string, string | number | undefined>,
  body?: unknown
): Promise<unknown> {
  const baseUrl = getBaseUrl();
  const url = new URL(path, baseUrl);

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${getToken()}`,
  };

  const fetchOptions: RequestInit = { method, headers };

  if (body) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), fetchOptions);

  if (!res.ok) {
    let errorMessage = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) errorMessage = data.error;
    } catch {
      // ignore JSON parse errors
    }
    throw new Error(`API error (${res.status}): ${errorMessage}`);
  }

  return res.json();
}

/** Build params with mailbox scoping for public API endpoints */
function withMailbox(
  params: Record<string, string | number | undefined>
): Record<string, string | number | undefined> {
  if (!useV1()) {
    params.to = getMailbox();
  }
  return params;
}

function inboxPath(): string {
  return useV1() ? "/v1/inbox" : "/api/inbox";
}
function codePath(): string {
  return useV1() ? "/v1/code" : "/api/code";
}
function emailPath(): string {
  return useV1() ? "/v1/email" : "/api/email";
}
function sendPath(): string {
  return useV1() ? "/v1/send" : "/api/send";
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "mails-agent",
  version: "1.4.0",
});

// 1. send_email
server.tool(
  "send_email",
  "Send an email from your mails-agent mailbox",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Plain text email body"),
    html: z.string().optional().describe("Optional HTML email body"),
  },
  async ({ to, subject, body, html }) => {
    try {
      const sendBody: Record<string, unknown> = {
        from: getMailbox(),
        to: [to],
        subject,
        text: body,
      };
      if (html) sendBody.html = html;

      const result = await apiCall("POST", sendPath(), undefined, sendBody);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// 2. get_inbox
server.tool(
  "get_inbox",
  "List recent emails in your mailbox",
  {
    limit: z
      .number()
      .optional()
      .default(20)
      .describe("Maximum number of emails to return (default 20)"),
    query: z
      .string()
      .optional()
      .describe("Optional search query to filter emails"),
    direction: z
      .enum(["inbound", "outbound"])
      .optional()
      .describe("Filter by email direction: inbound or outbound"),
  },
  async ({ limit, query, direction }) => {
    try {
      const params = withMailbox({
        limit,
        ...(query ? { query } : {}),
        ...(direction ? { direction } : {}),
      });
      const result = await apiCall("GET", inboxPath(), params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// 3. search_inbox
server.tool(
  "search_inbox",
  "Search emails in your mailbox by keyword",
  {
    query: z.string().describe("Search query keyword"),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe("Maximum number of results to return (default 20)"),
  },
  async ({ query, limit }) => {
    try {
      const params = withMailbox({ query, limit });
      const result = await apiCall("GET", inboxPath(), params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// 4. get_email
server.tool(
  "get_email",
  "Get full details of a specific email by its ID",
  {
    id: z.string().describe("Email ID"),
  },
  async ({ id }) => {
    try {
      const result = await apiCall("GET", emailPath(), { id });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// 5. wait_for_code
server.tool(
  "wait_for_code",
  "Wait for a verification code email to arrive (polls until received or timeout)",
  {
    timeout: z
      .number()
      .optional()
      .default(30)
      .describe("Maximum seconds to wait for the code (default 30)"),
  },
  async ({ timeout }) => {
    try {
      const params = withMailbox({ timeout });
      const result = (await apiCall("GET", codePath(), params)) as {
        code: string | null;
        from?: string;
        subject?: string;
      };
      if (!result.code) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  code: null,
                  message: "No code received within timeout",
                },
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// 6. delete_email
server.tool(
  "delete_email",
  "Delete an email by its ID",
  {
    id: z.string().describe("Email ID to delete"),
  },
  async ({ id }) => {
    try {
      const url = new URL(emailPath(), getBaseUrl());
      url.searchParams.set("id", id);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${getToken()}`,
      };
      const res = await fetch(url.toString(), { method: "DELETE", headers });

      if (res.status === 404) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { deleted: false, message: "Email not found" },
                null,
                2
              ),
            },
          ],
        };
      }

      if (!res.ok) {
        let errorMessage = res.statusText;
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) errorMessage = data.error;
        } catch {
          // ignore
        }
        throw new Error(`API error (${res.status}): ${errorMessage}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ deleted: true, id }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
