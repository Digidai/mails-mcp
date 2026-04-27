#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const CONFIG_PATH = join(homedir(), ".mails", "config.json");
export function loadConfig() {
    if (!existsSync(CONFIG_PATH)) {
        throw new Error("mails-agent not configured. Run: npm install -g mails-agent && mails claim <name>");
    }
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
}
// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
export let _config = null;
/** Reset cached config (for testing) */
export function resetConfig() {
    _config = null;
}
export function getConfig() {
    if (!_config) {
        _config = loadConfig();
    }
    return _config;
}
export function getBaseUrl() {
    const config = getConfig();
    return config.worker_url || "https://api.mails0.com";
}
export function getToken() {
    const config = getConfig();
    const token = config.api_key || config.worker_token;
    if (!token) {
        throw new Error("No API key or worker token found in ~/.mails/config.json. Run: mails claim <name>");
    }
    return token;
}
export function getMailbox() {
    const config = getConfig();
    const mailbox = config.mailbox || config.default_from;
    if (!mailbox) {
        throw new Error("No mailbox configured in ~/.mails/config.json. Run: mails claim <name>");
    }
    return mailbox;
}
export function useV1() {
    const config = getConfig();
    return !!config.api_key;
}
/**
 * Structured log to stderr. Never logs tokens, email bodies, or addresses.
 * Only logs: method, path, status codes, retry events, error messages.
 */
export function log(level, message, extra) {
    const entry = {
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
export async function fetchWithTimeout(method, url, options) {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxAttempts = options?.retry ? 3 : 1;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const headers = {
            Authorization: `Bearer ${getToken()}`,
        };
        const fetchOptions = { method, headers };
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
                    const data = (await res.json());
                    if (data.error)
                        errorMessage = data.error;
                }
                catch {
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
        }
        catch (err) {
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
        }
        finally {
            clearTimeout(timer);
        }
    }
    // Should not reach here, but satisfy TypeScript
    throw lastError ?? new Error("Request failed after retries");
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Build a full URL with query params for the mails API */
export function buildUrl(path, params) {
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
export async function apiCall(method, path, params, body, timeoutMs = DEFAULT_TIMEOUT_MS, retry = false) {
    const url = buildUrl(path, params);
    const res = await fetchWithTimeout(method, url, { body, timeoutMs, retry });
    // DELETE may return empty body
    const text = await res.text();
    if (!text)
        return { ok: true };
    try {
        return JSON.parse(text);
    }
    catch {
        return { ok: true, raw: text };
    }
}
/** Build params with mailbox scoping for public API endpoints */
export function withMailbox(params) {
    if (!useV1()) {
        params.to = getMailbox();
    }
    return params;
}
function inboxPath() {
    return useV1() ? "/v1/inbox" : "/api/inbox";
}
function codePath() {
    return useV1() ? "/v1/code" : "/api/code";
}
function emailPath() {
    return useV1() ? "/v1/email" : "/api/email";
}
function sendPath() {
    return useV1() ? "/v1/send" : "/api/send";
}
function attachmentPath() {
    return useV1() ? "/v1/attachment" : "/api/attachment";
}
function threadsPath() {
    return useV1() ? "/v1/threads" : "/api/threads";
}
function threadPath() {
    return useV1() ? "/v1/thread" : "/api/thread";
}
function extractPath() {
    return useV1() ? "/v1/extract" : "/api/extract";
}
// ---------------------------------------------------------------------------
// Tool response helpers
// ---------------------------------------------------------------------------
/** Format a successful tool result as JSON text */
export function toolResult(data) {
    return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
}
/** Format an error tool result */
export function toolError(err) {
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
// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require("../package.json");
export const server = new McpServer({
    name: "mails-agent",
    version: PKG_VERSION,
});
// 1. send_email
server.tool("send_email", "Send an email from your mails-agent mailbox", {
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Plain text email body"),
    html: z.string().optional().describe("Optional HTML email body"),
}, async ({ to, subject, body, html }) => {
    try {
        const sendBody = {
            from: getMailbox(),
            to: [to],
            subject,
            text: body,
        };
        if (html)
            sendBody.html = html;
        const result = await apiCall("POST", sendPath(), undefined, sendBody);
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// 2. get_inbox
server.tool("get_inbox", "List recent emails in your mailbox", {
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
}, async ({ limit, query, direction, label, mode }) => {
    try {
        const params = withMailbox({ limit, query, direction, label, mode });
        const result = await apiCall("GET", inboxPath(), params, undefined, DEFAULT_TIMEOUT_MS, true);
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// 3. search_inbox
server.tool("search_inbox", "Search emails in your mailbox by keyword, semantic similarity, or hybrid", {
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
}, async ({ query, limit, label, mode }) => {
    try {
        const params = withMailbox({ query, limit, label, mode });
        const result = await apiCall("GET", inboxPath(), params, undefined, DEFAULT_TIMEOUT_MS, true);
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// 4. get_email
server.tool("get_email", "Get full details of a specific email by its ID", {
    id: z.string().describe("Email ID"),
}, async ({ id }) => {
    try {
        const result = await apiCall("GET", emailPath(), { id }, undefined, DEFAULT_TIMEOUT_MS, true);
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// 5. wait_for_code
server.tool("wait_for_code", "Wait for a verification code email to arrive (polls until received or timeout)", {
    timeout: z
        .number()
        .optional()
        .default(30)
        .describe("Maximum seconds to wait for the code (default 30)"),
    since: z
        .string()
        .optional()
        .describe("Only return codes received after this ISO timestamp (e.g. 2026-03-27T10:00:00Z)"),
}, async ({ timeout, since }) => {
    try {
        const params = withMailbox({ timeout, since });
        // Server-side timeout up to 55s; give client extra buffer
        const clientTimeoutMs = (Math.min(timeout, 55) + 10) * 1000;
        const result = (await apiCall("GET", codePath(), params, undefined, clientTimeoutMs));
        if (!result.code) {
            return toolResult({ code: null, message: "No code received within timeout" });
        }
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// 6. delete_email
server.tool("delete_email", "Delete an email by its ID", {
    id: z.string().describe("Email ID to delete"),
}, async ({ id }) => {
    try {
        await apiCall("DELETE", emailPath(), { id });
        return toolResult({ deleted: true, id });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Treat 404 as "not found" rather than error
        if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
            return toolResult({ deleted: false, message: "Email not found" });
        }
        return toolError(err);
    }
});
// 7. get_attachment
server.tool("get_attachment", "Download an attachment by its ID (returns text content or download info)", {
    id: z.string().describe("Attachment ID"),
}, async ({ id }) => {
    try {
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
            message: "Binary attachment. Use the download URL directly or get_email to see attachment details.",
        });
    }
    catch (err) {
        return toolError(err);
    }
});
// 8. get_threads
server.tool("get_threads", "List email threads in your mailbox", {
    limit: z
        .number()
        .optional()
        .default(20)
        .describe("Maximum number of threads to return (default 20)"),
}, async ({ limit }) => {
    try {
        const params = withMailbox({ limit });
        const result = await apiCall("GET", threadsPath(), params, undefined, DEFAULT_TIMEOUT_MS, true);
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// 9. get_thread
server.tool("get_thread", "Get all emails in a specific thread", {
    id: z.string().describe("Thread ID"),
}, async ({ id }) => {
    try {
        const params = withMailbox({ id });
        const result = await apiCall("GET", threadPath(), params, undefined, DEFAULT_TIMEOUT_MS, true);
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// 10. extract_data
server.tool("extract_data", "Extract structured data from an email (order, shipping, calendar, receipt, code)", {
    email_id: z.string().describe("Email ID to extract data from"),
    type: z
        .enum(["order", "shipping", "calendar", "receipt", "code"])
        .describe("Type of data to extract"),
}, async ({ email_id, type }) => {
    try {
        const result = await apiCall("POST", extractPath(), undefined, {
            email_id,
            type,
        });
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
export async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
// Only start when executed directly (not imported for testing)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error("Fatal error:", err);
        process.exit(1);
    });
}
