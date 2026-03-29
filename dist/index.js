#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const CONFIG_PATH = join(homedir(), ".mails", "config.json");
function loadConfig() {
    if (!existsSync(CONFIG_PATH)) {
        throw new Error("mails-agent not configured. Run: npm install -g mails-agent && mails claim <name>");
    }
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
}
// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
let _config = null;
function getConfig() {
    if (!_config) {
        _config = loadConfig();
    }
    return _config;
}
function getBaseUrl() {
    const config = getConfig();
    return config.worker_url || "https://mails-worker.genedai.workers.dev";
}
function getToken() {
    const config = getConfig();
    const token = config.api_key || config.worker_token;
    if (!token) {
        throw new Error("No API key or worker token found in ~/.mails/config.json. Run: mails claim <name>");
    }
    return token;
}
function getMailbox() {
    const config = getConfig();
    const mailbox = config.mailbox || config.default_from;
    if (!mailbox) {
        throw new Error("No mailbox configured in ~/.mails/config.json. Run: mails claim <name>");
    }
    return mailbox;
}
function useV1() {
    const config = getConfig();
    return !!config.api_key;
}
/** Default fetch timeout in milliseconds (60s — covers wait_for_code's max 55s server-side) */
const DEFAULT_TIMEOUT_MS = 60_000;
async function apiCall(method, path, params, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const baseUrl = getBaseUrl();
    const url = new URL(path, baseUrl);
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) {
                url.searchParams.set(k, String(v));
            }
        }
    }
    const headers = {
        Authorization: `Bearer ${getToken()}`,
    };
    const fetchOptions = { method, headers };
    if (body) {
        headers["Content-Type"] = "application/json";
        fetchOptions.body = JSON.stringify(body);
    }
    // Abort after timeout
    const controller = new AbortController();
    fetchOptions.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url.toString(), fetchOptions);
    }
    catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
        }
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
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
        throw new Error(`API error (${res.status}): ${errorMessage}`);
    }
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
function withMailbox(params) {
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
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
    name: "mails-agent",
    version: "2.1.0",
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
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
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
        const params = withMailbox({
            limit,
            ...(query ? { query } : {}),
            ...(direction ? { direction } : {}),
            ...(label ? { label } : {}),
            ...(mode ? { mode } : {}),
        });
        const result = await apiCall("GET", inboxPath(), params);
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
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
        const params = withMailbox({ query, limit, ...(label ? { label } : {}), ...(mode ? { mode } : {}) });
        const result = await apiCall("GET", inboxPath(), params);
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
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
});
// 4. get_email
server.tool("get_email", "Get full details of a specific email by its ID", {
    id: z.string().describe("Email ID"),
}, async ({ id }) => {
    try {
        const result = await apiCall("GET", emailPath(), { id });
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
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
        const params = withMailbox({
            timeout,
            ...(since ? { since } : {}),
        });
        // Server-side timeout up to 55s; give client extra buffer
        const clientTimeoutMs = (Math.min(timeout, 55) + 10) * 1000;
        const result = (await apiCall("GET", codePath(), params, undefined, clientTimeoutMs));
        if (!result.code) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            code: null,
                            message: "No code received within timeout",
                        }, null, 2),
                    },
                ],
            };
        }
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
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
});
// 6. delete_email
server.tool("delete_email", "Delete an email by its ID", {
    id: z.string().describe("Email ID to delete"),
}, async ({ id }) => {
    try {
        const result = await apiCall("DELETE", emailPath(), { id });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ deleted: true, id }, null, 2),
                },
            ],
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Treat 404 as "not found" rather than error
        if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ deleted: false, message: "Email not found" }, null, 2),
                    },
                ],
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: `Error: ${msg}`,
                },
            ],
            isError: true,
        };
    }
});
// 7. get_attachment
server.tool("get_attachment", "Download an attachment by its ID (returns text content or download info)", {
    id: z.string().describe("Attachment ID"),
}, async ({ id }) => {
    try {
        const baseUrl = getBaseUrl();
        const url = new URL(attachmentPath(), baseUrl);
        url.searchParams.set("id", id);
        const headers = {
            Authorization: `Bearer ${getToken()}`,
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(url.toString(), {
                method: "GET",
                headers,
                signal: controller.signal,
            });
        }
        catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
                throw new Error(`Request timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`);
            }
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            let errorMessage = res.statusText;
            try {
                const data = (await res.json());
                if (data.error)
                    errorMessage = data.error;
            }
            catch {
                // ignore
            }
            throw new Error(`API error (${res.status}): ${errorMessage}`);
        }
        const contentType = res.headers.get("Content-Type") || "application/octet-stream";
        const disposition = res.headers.get("Content-Disposition") || "";
        // For text-based content, return the body as text
        if (contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml")) {
            const text = await res.text();
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            id,
                            content_type: contentType,
                            disposition,
                            content: text,
                        }, null, 2),
                    },
                ],
            };
        }
        // For binary content, return metadata only
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        id,
                        content_type: contentType,
                        disposition,
                        message: "Binary attachment. Use the download URL directly or get_email to see attachment details.",
                        download_url: url.toString().replace(/Bearer\s+\S+/, "***"),
                    }, null, 2),
                },
            ],
        };
    }
    catch (err) {
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
        const result = await apiCall("GET", threadsPath(), params);
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
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
});
// 9. get_thread
server.tool("get_thread", "Get all emails in a specific thread", {
    id: z.string().describe("Thread ID"),
}, async ({ id }) => {
    try {
        const params = withMailbox({ id });
        const result = await apiCall("GET", threadPath(), params);
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
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
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
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
});
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
