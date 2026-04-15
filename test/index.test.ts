import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:fs before importing the module
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

import { readFileSync, existsSync } from "node:fs";
import {
  resetConfig,
  getConfig,
  getBaseUrl,
  getToken,
  getMailbox,
  useV1,
  fetchWithTimeout,
  buildUrl,
  apiCall,
  withMailbox,
  toolResult,
  toolError,
  log,
  server,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setConfig(cfg: Record<string, string>) {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(cfg));
  resetConfig();
}

function mockFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

function mockResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  const status = init?.status ?? 200;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(text, { status, statusText: status === 200 ? "OK" : "Error", headers });
}

// ---------------------------------------------------------------------------
// Config Layer
// ---------------------------------------------------------------------------

describe("Config", () => {
  beforeEach(() => {
    resetConfig();
    vi.restoreAllMocks();
  });

  it("loadConfig throws when config file missing", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    resetConfig();
    expect(() => getConfig()).toThrow("mails-agent not configured");
  });

  it("loadConfig parses valid JSON", () => {
    setConfig({ api_key: "k1", mailbox: "m@test.com" });
    const cfg = getConfig();
    expect(cfg.api_key).toBe("k1");
    expect(cfg.mailbox).toBe("m@test.com");
  });

  it("getConfig caches after first call", () => {
    setConfig({ api_key: "k1", mailbox: "m@test.com" });
    getConfig(); // first call reads file
    vi.mocked(readFileSync).mockClear(); // reset count
    getConfig(); // second call should use cache
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("resetConfig clears cache", () => {
    setConfig({ api_key: "k1", mailbox: "m@test.com" });
    getConfig();
    resetConfig();
    setConfig({ api_key: "k2", mailbox: "m@test.com" });
    expect(getConfig().api_key).toBe("k2");
  });
});

describe("getBaseUrl", () => {
  beforeEach(() => { resetConfig(); vi.restoreAllMocks(); });

  it("returns worker_url when present", () => {
    setConfig({ api_key: "k", mailbox: "m", worker_url: "https://custom.com" });
    expect(getBaseUrl()).toBe("https://custom.com");
  });

  it("returns default when no worker_url", () => {
    setConfig({ api_key: "k", mailbox: "m" });
    expect(getBaseUrl()).toBe("https://api.mails0.com");
  });
});

describe("getToken", () => {
  beforeEach(() => { resetConfig(); vi.restoreAllMocks(); });

  it("returns api_key when present", () => {
    setConfig({ api_key: "my-key", mailbox: "m" });
    expect(getToken()).toBe("my-key");
  });

  it("returns worker_token when no api_key", () => {
    setConfig({ worker_token: "w-token", mailbox: "m" });
    expect(getToken()).toBe("w-token");
  });

  it("throws when no token", () => {
    setConfig({ mailbox: "m" });
    expect(() => getToken()).toThrow("No API key or worker token");
  });
});

describe("getMailbox", () => {
  beforeEach(() => { resetConfig(); vi.restoreAllMocks(); });

  it("returns mailbox", () => {
    setConfig({ api_key: "k", mailbox: "user@mails0.com" });
    expect(getMailbox()).toBe("user@mails0.com");
  });

  it("returns default_from when no mailbox", () => {
    setConfig({ api_key: "k", default_from: "alt@mails0.com" });
    expect(getMailbox()).toBe("alt@mails0.com");
  });

  it("throws when neither present", () => {
    setConfig({ api_key: "k" });
    expect(() => getMailbox()).toThrow("No mailbox configured");
  });
});

describe("useV1", () => {
  beforeEach(() => { resetConfig(); vi.restoreAllMocks(); });

  it("true when api_key present", () => {
    setConfig({ api_key: "k", mailbox: "m" });
    expect(useV1()).toBe(true);
  });

  it("false when no api_key", () => {
    setConfig({ worker_token: "w", mailbox: "m" });
    expect(useV1()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// URL Building & Mailbox Scoping
// ---------------------------------------------------------------------------

describe("buildUrl", () => {
  beforeEach(() => { resetConfig(); vi.restoreAllMocks(); });

  it("builds URL with params, skipping undefined", () => {
    setConfig({ api_key: "k", mailbox: "m", worker_url: "https://example.com" });
    const url = buildUrl("/v1/inbox", { limit: 10, query: undefined, label: "personal" });
    expect(url.pathname).toBe("/v1/inbox");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("label")).toBe("personal");
    expect(url.searchParams.has("query")).toBe(false);
  });
});

describe("withMailbox", () => {
  beforeEach(() => { resetConfig(); vi.restoreAllMocks(); });

  it("adds 'to' param when not v1 (self-hosted)", () => {
    setConfig({ worker_token: "w", mailbox: "test@mails0.com" });
    const params = withMailbox({ limit: 20 });
    expect(params.to).toBe("test@mails0.com");
  });

  it("does not add 'to' when v1 (hosted)", () => {
    setConfig({ api_key: "k", mailbox: "test@mails0.com" });
    const params = withMailbox({ limit: 20 });
    expect(params.to).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool Response Helpers
// ---------------------------------------------------------------------------

describe("toolResult", () => {
  it("wraps data as JSON text content", () => {
    const result = toolResult({ foo: "bar" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ foo: "bar" });
  });
});

describe("toolError", () => {
  it("formats Error instance", () => {
    const result = toolError(new Error("test error"));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: test error");
  });

  it("formats non-Error value", () => {
    const result = toolError("string error");
    expect(result.content[0].text).toBe("Error: string error");
  });
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe("log", () => {
  it("writes structured JSON to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    log("info", "test message", { extra: "data" });
    expect(spy).toHaveBeenCalledOnce();
    const output = JSON.parse((spy.mock.calls[0][0] as string).trim());
    expect(output.level).toBe("info");
    expect(output.msg).toBe("test message");
    expect(output.extra).toBe("data");
    expect(output.ts).toBeDefined();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// fetchWithTimeout
// ---------------------------------------------------------------------------

describe("fetchWithTimeout", () => {
  beforeEach(() => {
    resetConfig();
    vi.restoreAllMocks();
    setConfig({ api_key: "test-token", mailbox: "m@test.com", worker_url: "https://example.com" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns response on success", async () => {
    mockFetch(mockResponse({ emails: [] }));
    const url = new URL("https://example.com/v1/inbox");
    const res = await fetchWithTimeout("GET", url);
    expect(res.ok).toBe(true);
  });

  it("includes Bearer token in Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const url = new URL("https://example.com/v1/inbox");
    await fetchWithTimeout("GET", url);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer test-token");
  });

  it("throws on HTTP 4xx without retry", async () => {
    mockFetch(mockResponse({ error: "Not found" }, { status: 404 }));
    const url = new URL("https://example.com/v1/email");
    await expect(fetchWithTimeout("GET", url)).rejects.toThrow("API error (404): Not found");
  });

  it("throws on HTTP 5xx without retry when retry=false", async () => {
    mockFetch(mockResponse({ error: "Internal" }, { status: 500 }));
    const url = new URL("https://example.com/v1/inbox");
    await expect(fetchWithTimeout("GET", url)).rejects.toThrow("API error (500)");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx when retry=true and succeeds", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ error: "down" }, { status: 500 }))
      .mockResolvedValueOnce(mockResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const url = new URL("https://example.com/v1/inbox");
    const res = await fetchWithTimeout("GET", url, { retry: true });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on network TypeError when retry=true", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(mockResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const url = new URL("https://example.com/v1/inbox");
    const res = await fetchWithTimeout("GET", url, { retry: true });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries exhausted", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ error: "down" }, { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const url = new URL("https://example.com/v1/inbox");
    await expect(
      fetchWithTimeout("GET", url, { retry: true })
    ).rejects.toThrow("API error (500)");
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 original + 2 retries
  });

  it("sends JSON body for POST requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const url = new URL("https://example.com/v1/send");
    await fetchWithTimeout("POST", url, { body: { to: ["a@b.com"] } });

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ to: ["a@b.com"] });
    expect(opts.headers["Content-Type"]).toBe("application/json");
  });

  it("uses statusText when error response has no JSON body", async () => {
    const res = new Response("not json", { status: 403, statusText: "Forbidden" });
    mockFetch(res);
    const url = new URL("https://example.com/v1/inbox");
    await expect(fetchWithTimeout("GET", url)).rejects.toThrow("API error (403): Forbidden");
  });
});

// ---------------------------------------------------------------------------
// apiCall
// ---------------------------------------------------------------------------

describe("apiCall", () => {
  beforeEach(() => {
    resetConfig();
    vi.restoreAllMocks();
    setConfig({ api_key: "t", mailbox: "m", worker_url: "https://example.com" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on success", async () => {
    mockFetch(mockResponse({ emails: [1, 2] }));
    const result = await apiCall("GET", "/v1/inbox", { limit: 10 });
    expect(result).toEqual({ emails: [1, 2] });
  });

  it("returns {ok: true} for empty body", async () => {
    mockFetch(mockResponse(""));
    const result = await apiCall("DELETE", "/v1/email", { id: "123" });
    expect(result).toEqual({ ok: true });
  });

  it("returns {ok: true, raw} for non-JSON text", async () => {
    mockFetch(mockResponse("plain text"));
    const result = await apiCall("GET", "/v1/test");
    expect(result).toEqual({ ok: true, raw: "plain text" });
  });

  it("propagates errors from fetchWithTimeout", async () => {
    mockFetch(mockResponse({ error: "Unauthorized" }, { status: 401 }));
    await expect(apiCall("GET", "/v1/inbox")).rejects.toThrow("API error (401)");
  });
});

// ---------------------------------------------------------------------------
// MCP Server (smoke test)
// ---------------------------------------------------------------------------

describe("MCP Server", () => {
  it("server is defined and created", () => {
    expect(server).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Import/Startup guard
// ---------------------------------------------------------------------------

describe("Startup guard", () => {
  it("importing the module does not crash (main() not called)", () => {
    // If we got this far, the import succeeded without starting stdio
    expect(true).toBe(true);
  });
});
