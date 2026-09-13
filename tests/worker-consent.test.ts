import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createOfflineCacheWorkerScript, classifyOfflineCacheRequest } from "../src/index.js";

function worker() {
  const listeners: Record<string, (event: unknown) => void> = {};
  const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined), delete: vi.fn(async () => true) };
  const caches = { open: vi.fn(async () => cache), keys: vi.fn(async () => ["plasius-offline-app-test", "unrelated"]), delete: vi.fn(async () => true) };
  const fetch = vi.fn(async () => new Response("asset"));
  let time = 1_000;
  runInNewContext(createOfflineCacheWorkerScript({ buildId: "test", requireConsent: true, policy: { sameOriginOnly: true, immutableAssetPathPrefixes: ["/assets/"], publicNavigationPaths: ["/"], publicAssetPathPrefixes: ["/public/"], immutableAssetPathPatterns: [/^\/world\/[a-f0-9]{64}$/u], deniedPathPatterns: [/private/u] } }), {
    self: { location: { origin: "https://example.invalid" }, addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener; } },
    caches, fetch, URL, Response, Date: { now: () => time },
  });
  const message = async (allowedUntil: number, source = "https://example.invalid/") => {
    let pending: Promise<unknown> = Promise.resolve();
    const ack = vi.fn();
    listeners.message!({ data: { type: "plasius-offline-consent-v1", allowedUntil }, source: { url: source }, ports: [{ postMessage: ack }], waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending; return ack;
  };
  const request = (path = "/assets/test.js", mode = "cors") => {
    let response: Promise<Response> | undefined;
    listeners.fetch!({ request: { url: "https://example.invalid" + path, method: "GET", mode, headers: new Headers() }, respondWith: (p: Promise<Response>) => { response = p; } });
    return response;
  };
  return { cache, caches, fetch, message, request, expire: () => { time = 100_000; } };
}
describe("worker consent boundary", () => {
  it("does not open or read caches before permission, then caches after a bounded grant", async () => {
    const w = worker(); expect(w.request()).toBeUndefined(); expect(w.caches.open).not.toHaveBeenCalled();
    await w.message(20_000); await w.request(); expect(w.cache.put).toHaveBeenCalledOnce();
    w.expire(); expect(w.request()).toBeUndefined(); expect(w.caches.open).toHaveBeenCalledOnce();
  });
  it("acknowledges denial only after deleting its own caches", async () => {
    const w = worker(); await w.message(20_000); const ack = await w.message(0);
    expect(ack).toHaveBeenCalledWith({ type: "plasius-offline-consent-v1", disabled: true });
    expect(w.caches.delete).toHaveBeenCalledExactlyOnceWith("plasius-offline-app-test");
    expect(w.request()).toBeUndefined();
  });
  it("never repopulates a cache from an in-flight response after withdrawal", async () => {
    const w = worker(); let complete!: (r: Response) => void;
    w.fetch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    await w.message(20_000); const pending = w.request();
    await vi.waitFor(() => expect(w.fetch).toHaveBeenCalledOnce());
    await w.message(0); complete(new Response("late")); await pending;
    expect(w.cache.put).not.toHaveBeenCalled();
  });
  it("rejects other-origin grants and caps the permission lifetime", async () => {
    const w = worker(); await w.message(1_000_000, "https://other.invalid/");
    expect(w.request()).toBeUndefined();
    await w.message(1_000_000); w.expire(); expect(w.request()).toBeUndefined();
  });
  it("removes a cache opened concurrently with withdrawal", async () => {
    const w = worker(); let opened!: (value: typeof w.cache) => void;
    w.caches.open.mockImplementation(() => new Promise(resolve => { opened = resolve; }));
    await w.message(20_000); const pending = w.request();
    await w.message(0); opened(w.cache); await pending;
    expect(w.cache.match).not.toHaveBeenCalled(); expect(w.cache.put).not.toHaveBeenCalled();
    expect(w.caches.delete).toHaveBeenCalledWith("plasius-offline-app-test");
  });
  it.each([["/public/model", "cors"], ["/", "navigate"]])("blocks a delayed %s response after withdrawal", async (path, mode) => {
    const w = worker(); let complete!: (value: Response) => void;
    w.fetch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    await w.message(20_000); const pending = w.request(path, mode);
    await vi.waitFor(() => expect(w.fetch).toHaveBeenCalledOnce());
    await w.message(0); complete(new Response("late")); await pending;
    expect(w.cache.put).not.toHaveBeenCalled();
  });
  it("uses precise immutable patterns in both the host and generated worker while denying protected paths", async () => {
    const path = "/world/" + "a".repeat(64);
    const w = worker(); await w.message(20_000); await w.request(path);
    expect(w.cache.put).toHaveBeenCalledOnce(); expect(w.request("/world/manifest")).toBeUndefined();
    expect(w.request("/public/private")).toBeUndefined();
    const policy = { immutableAssetPathPatterns: [/^\/world\/[a-f0-9]{64}$/u] };
    expect(classifyOfflineCacheRequest("https://example.invalid" + path, undefined, policy, { location: { origin: "https://example.invalid" } })).toMatchObject({ cacheable: true, strategy: "cache-first" });
  });

});
