#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export interface MailsConfig {
    worker_url?: string;
    worker_token?: string;
    api_key?: string;
    mailbox?: string;
    default_from?: string;
}
export declare function loadConfig(): MailsConfig;
export declare let _config: MailsConfig | null;
/** Reset cached config (for testing) */
export declare function resetConfig(): void;
export declare function getConfig(): MailsConfig;
export declare function getBaseUrl(): string;
export declare function getToken(): string;
export declare function getMailbox(): string;
export declare function useV1(): boolean;
type LogLevel = "info" | "warn" | "error";
/**
 * Structured log to stderr. Never logs tokens, email bodies, or addresses.
 * Only logs: method, path, status codes, retry events, error messages.
 */
export declare function log(level: LogLevel, message: string, extra?: Record<string, unknown>): void;
/**
 * Low-level fetch with timeout, auth, and optional retry.
 * Returns the raw Response.
 *
 * Retry is only attempted for GET requests when `retry` is true.
 * Max 2 retries with exponential backoff (500ms, 1500ms).
 * Only retries on network errors and 5xx responses (not 4xx).
 */
export declare function fetchWithTimeout(method: string, url: URL, options?: {
    body?: unknown;
    timeoutMs?: number;
    retry?: boolean;
}): Promise<Response>;
/** Build a full URL with query params for the mails API */
export declare function buildUrl(path: string, params?: Record<string, string | number | undefined>): URL;
export declare function apiCall(method: string, path: string, params?: Record<string, string | number | undefined>, body?: unknown, timeoutMs?: number, retry?: boolean): Promise<unknown>;
/** Build params with mailbox scoping for public API endpoints */
export declare function withMailbox(params: Record<string, string | number | undefined>): Record<string, string | number | undefined>;
/** Format a successful tool result as JSON text */
export declare function toolResult(data: unknown): {
    content: {
        type: "text";
        text: string;
    }[];
};
/** Format an error tool result */
export declare function toolError(err: unknown): {
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
};
export declare const server: McpServer;
export declare function main(): Promise<void>;
export {};
