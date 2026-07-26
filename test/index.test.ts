import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:fs before importing the module
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  realpathSync: vi.fn((value: string) => value),
}));

import { readFileSync, existsSync, writeFileSync, chmodSync } from "node:fs";
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
  createTemporaryMailbox,
  ensureMailboxConfigured,
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

afterEach(() => {
  delete process.env.MAILS_API_URL;
  delete process.env.MAILS_API_KEY;
  delete process.env.MAILS_MAILBOX;
  delete process.env.MAILS_WORKER_TOKEN;
});

// ---------------------------------------------------------------------------
// Config Layer
// ---------------------------------------------------------------------------

describe("Config", () => {
  beforeEach(() => {
    resetConfig();
    vi.restoreAllMocks();
    delete process.env.MAILS_API_URL;
    delete process.env.MAILS_API_KEY;
    delete process.env.MAILS_MAILBOX;
    delete process.env.MAILS_WORKER_TOKEN;
  });

  it("loads an empty config when the file is missing so bootstrap remains available", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    resetConfig();
    expect(getConfig()).toEqual({});
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

  it("reads the documented MCP environment variables", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    process.env.MAILS_API_URL = "https://api.example.com";
    process.env.MAILS_API_KEY = "env-key";
    process.env.MAILS_MAILBOX = "env@mails0.com";
    resetConfig();
    expect(getConfig()).toMatchObject({
      worker_url: "https://api.example.com",
      api_key: "env-key",
      mailbox: "env@mails0.com",
      default_from: "env@mails0.com",
    });
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
    expect(opts.headers["X-Mails-Client"]).toBe("mails-agent-mcp");
    expect(opts.headers["X-Mails-Client-Version"]).toMatch(/^\d+\.\d+\.\d+$/);
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

describe("Automatic provisional mailbox bootstrap", () => {
  beforeEach(() => {
    resetConfig();
    vi.restoreAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores the API key locally but never returns it to the model", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({
        mailbox: "agent-abc123@mails0.com",
        api_key: "mk_secret_value",
        scope: "provisional",
        expires_at: "2026-07-29T00:00:00.000Z",
        capabilities: ["inbox.read", "code.read"],
      }, { status: 201 }))
      .mockResolvedValueOnce(mockResponse({ emails: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createTemporaryMailbox();
    expect(result.mailbox).toBe("agent-abc123@mails0.com");
    expect(JSON.stringify(result)).not.toContain("mk_secret_value");
    expect(vi.mocked(writeFileSync)).toHaveBeenCalled();
    const writes = vi.mocked(writeFileSync).mock.calls;
    expect(writes.some((call) => String(call[1]).includes("mk_secret_value"))).toBe(true);
    expect(vi.mocked(chmodSync)).toHaveBeenCalledWith(expect.any(String), 0o600);

    const bootstrapOptions = fetchMock.mock.calls[0][1] as RequestInit;
    expect((bootstrapOptions.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    expect((bootstrapOptions.headers as Record<string, string>)["X-Mails-Client"]).toBe("mails-agent-mcp");
  });

  it("lazily bootstraps when another mailbox tool is called without config", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({
        mailbox: "agent-lazy@mails0.com",
        api_key: "mk_lazy_secret",
        scope: "provisional",
        expires_at: "2026-07-29T00:00:00.000Z",
        capabilities: ["inbox.read", "code.read"],
      }, { status: 201 }))
      .mockResolvedValueOnce(mockResponse({ emails: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await ensureMailboxConfigured();
    expect(getConfig()).toMatchObject({
      mailbox: "agent-lazy@mails0.com",
      token_scope: "provisional",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent bootstrap attempts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({
        mailbox: "agent-concurrent@mails0.com",
        api_key: "mk_concurrent_secret",
        scope: "provisional",
        expires_at: "2026-07-29T00:00:00.000Z",
      }, { status: 201 }))
      .mockResolvedValueOnce(mockResponse({ emails: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      createTemporaryMailbox(),
      createTemporaryMailbox(),
    ]);
    expect(first.mailbox).toBe(second.mailbox);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
