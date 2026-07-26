#!/usr/bin/env node

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  existsSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MailsConfig {
  worker_url?: string;
  worker_token?: string;
  api_key?: string;
  mailbox?: string;
  default_from?: string;
  token_scope?: "operator" | "mailbox" | "provisional";
  token_expires_at?: string;
  bootstrap_idempotency_key?: string;
}

export const CONFIG_PATH = join(homedir(), ".mails", "config.json");

export function loadConfig(): MailsConfig {
  const fileConfig = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as MailsConfig
    : {};
  return {
    ...fileConfig,
    ...(process.env.MAILS_API_URL ? { worker_url: process.env.MAILS_API_URL } : {}),
    ...(process.env.MAILS_API_KEY ? { api_key: process.env.MAILS_API_KEY } : {}),
    ...(process.env.MAILS_WORKER_TOKEN ? { worker_token: process.env.MAILS_WORKER_TOKEN } : {}),
    ...(process.env.MAILS_MAILBOX ? {
      mailbox: process.env.MAILS_MAILBOX,
      default_from: process.env.MAILS_MAILBOX,
    } : {}),
  };
}

export function saveConfig(values: Partial<MailsConfig>): MailsConfig {
  const existing = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as MailsConfig
    : {};
  const config = { ...existing, ...values };
  const configDir = dirname(CONFIG_PATH);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
  _config = config;
  return config;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

export let _config: MailsConfig | null = null;

/** Reset cached config (for testing) */
export function resetConfig(): void {
  _config = null;
}

export function getConfig(): MailsConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

export function getBaseUrl(): string {
  const config = getConfig();
  return config.worker_url || "https://api.mails0.com";
}

export function getToken(): string {
  const config = getConfig();
  const token = config.api_key || config.worker_token;
  if (!token) {
    throw new Error(
      "No API key or worker token found in ~/.mails/config.json. "
      + "Retry the tool to bootstrap automatically, or run mails bootstrap"
    );
  }
  return token;
}

export function getMailbox(): string {
  const config = getConfig();
  const mailbox = config.mailbox || config.default_from;
  if (!mailbox) {
    throw new Error(
      "No mailbox configured in ~/.mails/config.json. "
      + "Retry the tool to bootstrap automatically, or run mails bootstrap"
    );
  }
  return mailbox;
}

export function useV1(): boolean {
  const config = getConfig();
  return !!config.api_key;
}

// ---------------------------------------------------------------------------
// Logging (structured, to stderr, with redaction)
// ---------------------------------------------------------------------------

type LogLevel = "info" | "warn" | "error";

/**
 * Structured log to stderr. Never logs tokens, email bodies, or addresses.
 * Only logs: method, path, status codes, retry events, error messages.
 */
export function log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...extra,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

/** Default fetch timeout in milliseconds (60s — covers wait_for_code's max 55s server-side) */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Low-level fetch with timeout, auth, and optional retry.
 * Returns the raw Response.
 *
 * Retry is only attempted for GET requests when `retry` is true.
 * Max 2 retries with exponential backoff (500ms, 1500ms).
 * Only retries on network errors and 5xx responses (not 4xx).
 */
export async function fetchWithTimeout(
  method: string,
  url: URL,
  options?: { body?: unknown; timeoutMs?: number; retry?: boolean }
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options?.retry ? 3 : 1;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${getToken()}`,
      ...mcpClientHeaders("mailbox-api"),
    };

    const fetchOptions: RequestInit = { method, headers };

    if (options?.body) {
      headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    fetchOptions.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url.toString(), fetchOptions);
      if (!res.ok) {
        let errorMessage = res.statusText;
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) errorMessage = data.error;
        } catch {
          // ignore JSON parse errors
        }
        const err = new Error(`API error (${res.status}): ${errorMessage}`);
        // Retry on 5xx only
        if (res.status >= 500 && attempt < maxAttempts) {
          lastError = err;
          log("warn", `Retry ${attempt}/${maxAttempts - 1} after ${res.status} for ${method} ${url.pathname}`);
          await sleep(attempt === 1 ? 500 : 1500);
          continue;
        }
        throw err;
      }
      return res;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
      }
      // Retry on network errors (TypeError from fetch)
      if (err instanceof TypeError && attempt < maxAttempts) {
        lastError = err;
        log("warn", `Retry ${attempt}/${maxAttempts - 1} after network error for ${method} ${url.pathname}`);
        await sleep(attempt === 1 ? 500 : 1500);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Should not reach here, but satisfy TypeScript
  throw lastError ?? new Error("Request failed after retries");
}

function mcpClientHeaders(flow: string): Record<string, string> {
  return {
    "X-Mails-Client": "mails-agent-mcp",
    "X-Mails-Client-Version": PKG_VERSION,
    "X-Mails-Source": "mcp",
    "X-Mails-Flow": flow,
  };
}

export type TemporaryMailboxResult = {
  mailbox: string;
  scope: "operator" | "mailbox" | "provisional";
  expires_at: string;
  capabilities: string[];
  reused: boolean;
  next_step: string;
};

let bootstrapInFlight: Promise<TemporaryMailboxResult> | null = null;

export async function createTemporaryMailbox(): Promise<TemporaryMailboxResult> {
  if (!bootstrapInFlight) {
    bootstrapInFlight = createTemporaryMailboxInternal();
  }
  try {
    return await bootstrapInFlight;
  } finally {
    bootstrapInFlight = null;
  }
}

async function createTemporaryMailboxInternal(): Promise<TemporaryMailboxResult> {
  const config = getConfig();
  const baseUrl = process.env.MAILS_API_URL || config.worker_url || "https://api.mails0.com";

  if (config.api_key && (config.mailbox || config.default_from)) {
    try {
      const existing = await fetch(new URL("/v1/me", baseUrl), {
        headers: {
          Authorization: `Bearer ${config.api_key}`,
          ...mcpClientHeaders("bootstrap-reuse"),
        },
      });
      if (existing.ok) {
        const me = await existing.json() as {
          mailbox?: string;
          scope?: "operator" | "mailbox" | "provisional";
          expires_at?: string;
          capabilities?: string[];
        };
        if (me.mailbox) {
          return {
            mailbox: me.mailbox,
            scope: me.scope || config.token_scope || "mailbox",
            expires_at: me.expires_at || config.token_expires_at || "",
            capabilities: me.capabilities || ["inbox.read", "email.read", "code.read"],
            reused: true,
            next_step: "Use get_inbox or wait_for_code. Claim a permanent mailbox at https://mails0.com.",
          };
        }
      }
    } catch {
      // Invalid/expired local credentials fall through to a new provisional grant.
    }
  }

  const idempotencyKey = config.bootstrap_idempotency_key || crypto.randomUUID();
  if (!config.bootstrap_idempotency_key) {
    saveConfig({ bootstrap_idempotency_key: idempotencyKey });
  }

  const response = await fetch(new URL("/v1/bootstrap", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...mcpClientHeaders("provisional-bootstrap"),
    },
    body: "{}",
  });
  const data = await response.json() as {
    mailbox?: string;
    api_key?: string;
    scope?: "provisional";
    expires_at?: string;
    capabilities?: string[];
    error?: string;
  };
  if (!response.ok || !data.mailbox || !data.api_key || !data.expires_at) {
    throw new Error(data.error || `Bootstrap failed with HTTP ${response.status}`);
  }

  saveConfig({
    worker_url: baseUrl,
    api_key: data.api_key,
    mailbox: data.mailbox,
    default_from: data.mailbox,
    token_scope: "provisional",
    token_expires_at: data.expires_at,
    bootstrap_idempotency_key: idempotencyKey,
  });

  const inbox = await fetch(new URL("/v1/inbox?limit=1", baseUrl), {
    headers: {
      Authorization: `Bearer ${data.api_key}`,
      ...mcpClientHeaders("provisional-bootstrap"),
    },
  });
  if (!inbox.ok) {
    throw new Error(`Mailbox was created but the first inbox check failed with HTTP ${inbox.status}`);
  }

  return {
    mailbox: data.mailbox,
    scope: "provisional",
    expires_at: data.expires_at,
    capabilities: data.capabilities || ["inbox.read", "email.read", "code.read"],
    reused: false,
    next_step: "Use get_inbox or wait_for_code. Claim a permanent mailbox at https://mails0.com.",
  };
}

export async function ensureMailboxConfigured(): Promise<void> {
  const config = getConfig();
  if ((config.api_key || config.worker_token) && (config.mailbox || config.default_from)) {
    return;
  }
  await createTemporaryMailbox();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a full URL with query params for the mails API */
export function buildUrl(
  path: string,
  params?: Record<string, string | number | undefined>
): URL {
  const url = new URL(path, getBaseUrl());
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url;
}

export async function apiCall(
  method: string,
  path: string,
  params?: Record<string, string | number | undefined>,
  body?: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  retry: boolean = false
): Promise<unknown> {
  const url = buildUrl(path, params);
  const res = await fetchWithTimeout(method, url, { body, timeoutMs, retry });

  // DELETE may return empty body
  const text = await res.text();
  if (!text) return { ok: true };
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, raw: text };
  }
}

/** Build params with mailbox scoping for public API endpoints */
export function withMailbox(
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
function attachmentPath(): string {
  return useV1() ? "/v1/attachment" : "/api/attachment";
}
function threadsPath(): string {
  return useV1() ? "/v1/threads" : "/api/threads";
}
function threadPath(): string {
  return useV1() ? "/v1/thread" : "/api/thread";
}
function extractPath(): string {
  return useV1() ? "/v1/extract" : "/api/extract";
}

const emailListSchema = z
  .union([z.string(), z.array(z.string()).min(1)])
  .describe("Email address or list of email addresses");

const attachmentSchema = z.object({
  filename: z.string().min(1).describe("Attachment filename"),
  content: z.string().describe("Base64-encoded attachment content"),
  content_type: z.string().optional().describe("MIME type, for example application/pdf"),
  content_id: z.string().optional().describe("Optional content ID for inline attachments"),
});

function normalizeEmailList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------
// Tool response helpers
// ---------------------------------------------------------------------------

/** Format a successful tool result as JSON text */
export function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Format an error tool result */
export function toolError(err: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require("../package.json") as { version: string };

export const server = new McpServer({
  name: "mails-agent",
  version: PKG_VERSION,
});

server.tool(
  "create_temporary_mailbox",
  "Create a random 72-hour receive-only mails0 mailbox without browser approval. The API key is stored locally and is never returned to the model. Call this when no mailbox is configured.",
  {},
  async () => {
    try {
      return toolResult(await createTemporaryMailbox());
    } catch (err) {
      return toolError(err);
    }
  }
);

// 1. send_email
server.tool(
  "send_email",
  "Send an email from a permanent mails-agent mailbox. With no configuration, a safe temporary mailbox is created first and the API explains how to upgrade.",
  {
    to: emailListSchema,
    cc: emailListSchema.optional().describe("CC recipient email address or addresses"),
    bcc: emailListSchema.optional().describe("BCC recipient email address or addresses"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Plain text email body"),
    html: z.string().optional().describe("Optional HTML email body"),
    reply_to: z.string().optional().describe("Optional Reply-To email address"),
    in_reply_to: z
      .string()
      .optional()
      .describe("Message-ID being replied to, used for email threading"),
    attachments: z
      .array(attachmentSchema)
      .optional()
      .describe("Optional base64-encoded attachments"),
  },
  async ({ to, cc, bcc, subject, body, html, reply_to, in_reply_to, attachments }) => {
    try {
      await ensureMailboxConfigured();
      const sendBody: Record<string, unknown> = {
        from: getMailbox(),
        to: normalizeEmailList(to),
        subject,
        text: body,
      };
      if (html) sendBody.html = html;
      const normalizedCc = normalizeEmailList(cc);
      const normalizedBcc = normalizeEmailList(bcc);
      if (normalizedCc?.length) sendBody.cc = normalizedCc;
      if (normalizedBcc?.length) sendBody.bcc = normalizedBcc;
      if (reply_to) sendBody.reply_to = reply_to;
      if (in_reply_to) sendBody.in_reply_to = in_reply_to;
      if (attachments?.length) sendBody.attachments = attachments;

      const result = await apiCall("POST", sendPath(), undefined, sendBody);
      return toolResult(result);
    } catch (err) {
      return toolError(err);
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
    label: z
      .string()
      .optional()
      .describe("Filter by label: newsletter, notification, code, personal"),
    mode: z
      .enum(["keyword", "semantic", "hybrid"])
      .optional()
      .describe("Search mode: keyword (FTS5), semantic (vector), hybrid (both). Default: keyword"),
  },
  async ({ limit, query, direction, label, mode }) => {
    try {
      await ensureMailboxConfigured();
      const params = withMailbox({ limit, query, direction, label, mode });
      const result = await apiCall("GET", inboxPath(), params, undefined, DEFAULT_TIMEOUT_MS, true);
      return toolResult(result);
    } catch (err) {
      return toolError(err);
    }
  }
);

// 3. search_inbox
server.tool(
  "search_inbox",
  "Search emails in your mailbox by keyword, semantic similarity, or hybrid",
  {
    query: z.string().describe("Search query keyword"),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe("Maximum number of results to return (default 20)"),
    label: z
      .string()
      .optional()
      .describe("Filter by label: newsletter, notification, code, personal"),
    mode: z
      .enum(["keyword", "semantic", "hybrid"])
      .optional()
      .describe("Search mode: keyword (FTS5), semantic (vector), hybrid (both). Default: keyword"),
  },
  async ({ query, limit, label, mode }) => {
    try {
      await ensureMailboxConfigured();
      const params = withMailbox({ query, limit, label, mode });
      const result = await apiCall("GET", inboxPath(), params, undefined, DEFAULT_TIMEOUT_MS, true);
      return toolResult(result);
    } catch (err) {
      return toolError(err);
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
      await ensureMailboxConfigured();
      const result = await apiCall("GET", emailPath(), { id }, undefined, DEFAULT_TIMEOUT_MS, true);
      return toolResult(result);
    } catch (err) {
      return toolError(err);
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
    since: z
      .string()
      .optional()
      .describe("Only return codes received after this ISO timestamp (e.g. 2026-03-27T10:00:00Z)"),
  },
  async ({ timeout, since }) => {
    try {
      await ensureMailboxConfigured();
      const params = withMailbox({ timeout, since });
      // Server-side timeout up to 55s; give client extra buffer
      const clientTimeoutMs = (Math.min(timeout, 55) + 10) * 1000;
      const result = (await apiCall("GET", codePath(), params, undefined, clientTimeoutMs)) as {
        code: string | null;
        from?: string;
        subject?: string;
      };
      if (!result.code) {
        return toolResult({ code: null, message: "No code received within timeout" });
      }
      return toolResult(result);
    } catch (err) {
      return toolError(err);
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
      await ensureMailboxConfigured();
      await apiCall("DELETE", emailPath(), { id });
      return toolResult({ deleted: true, id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Treat 404 as "not found" rather than error
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
        return toolResult({ deleted: false, message: "Email not found" });
      }
      return toolError(err);
    }
  }
);

// 7. get_attachment
server.tool(
  "get_attachment",
  "Download an attachment by its ID (returns text content or download info)",
  {
    id: z.string().describe("Attachment ID"),
  },
  async ({ id }) => {
    try {
      await ensureMailboxConfigured();
      const url = buildUrl(attachmentPath(), { id });
      const res = await fetchWithTimeout("GET", url);

      const contentType = res.headers.get("Content-Type") || "application/octet-stream";
      const disposition = res.headers.get("Content-Disposition") || "";

      // For text-based content, return the body as text
      if (contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml")) {
        const text = await res.text();
        return toolResult({ id, content_type: contentType, disposition, content: text });
      }

      // For binary content, return metadata only
      return toolResult({
        id,
        content_type: contentType,
        disposition,
        message:
          "Binary attachment. Use the download URL directly or get_email to see attachment details.",
      });
    } catch (err) {
      return toolError(err);
    }
  }
);

// 8. get_threads
server.tool(
  "get_threads",
  "List email threads in your mailbox",
  {
    limit: z
      .number()
      .optional()
      .default(20)
      .describe("Maximum number of threads to return (default 20)"),
  },
  async ({ limit }) => {
    try {
      await ensureMailboxConfigured();
      const params = withMailbox({ limit });
      const result = await apiCall("GET", threadsPath(), params, undefined, DEFAULT_TIMEOUT_MS, true);
      return toolResult(result);
    } catch (err) {
      return toolError(err);
    }
  }
);

// 9. get_thread
server.tool(
  "get_thread",
  "Get all emails in a specific thread",
  {
    id: z.string().describe("Thread ID"),
  },
  async ({ id }) => {
    try {
      await ensureMailboxConfigured();
      const params = withMailbox({ id });
      const result = await apiCall("GET", threadPath(), params, undefined, DEFAULT_TIMEOUT_MS, true);
      return toolResult(result);
    } catch (err) {
      return toolError(err);
    }
  }
);

// 10. extract_data
server.tool(
  "extract_data",
  "Extract structured data from an email (order, shipping, calendar, receipt, code)",
  {
    email_id: z.string().describe("Email ID to extract data from"),
    type: z
      .enum(["order", "shipping", "calendar", "receipt", "code"])
      .describe("Type of data to extract"),
  },
  async ({ email_id, type }) => {
    try {
      await ensureMailboxConfigured();
      const result = await apiCall("POST", extractPath(), undefined, {
        email_id,
        type,
      });
      return toolResult(result);
    } catch (err) {
      return toolError(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start when executed directly (not imported for testing)
function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    return resolve(process.argv[1]) === resolve(modulePath);
  }
}

if (isDirectExecution()) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
