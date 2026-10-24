import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createOfflineCacheWorkerScript, classifyOfflineCacheRequest } from "../src/index.js";

function worker(requireConsent = true) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const cache = { match: vi.fn(async (_request: unknown): Promise<Response | undefined> => undefined), put: vi.fn(async () => undefined), delete: vi.fn(async () => true) };
  const caches = { open: vi.fn(async () => cache), keys: vi.fn(async () => ["plasius-offline-app-test", "unrelated"]), delete: vi.fn(async () => true) };
  const fetch = vi.fn(async () => new Response("asset"));
  let time = 1_000;
  runInNewContext(createOfflineCacheWorkerScript({ buildId: "test", requireConsent, policy: { sameOriginOnly: true, immutableAssetPathPrefixes: ["/assets/"], publicNavigationPaths: ["/"], publicAssetPathPrefixes: ["/public/"], immutableAssetPathPatterns: [/^\/world\/[a-f0-9]{64}$/u], deniedPathPatterns: [/private/u] } }), {
    self: { location: { origin: "https://example.invalid" }, addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener; } },
    caches, fetch, URL, Response, Date: { now: () => time },
  });
  const message = async (allowedUntil: number, source = "https://example.invalid/") => {
    let pending: Promise<unknown> = Promise.resolve();
    const ack = vi.fn();
    listeners.message!({ data: { type: "plasius-offline-consent-v1", allowedUntil }, source: { url: source }, ports: [{ postMessage: ack }], waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending; return ack;
  };
  const request = (path = "/assets/test.js", mode = "cors", headers = new Headers()) => {
    let response: Promise<Response> | undefined;
    listeners.fetch!({ request: { url: "https://example.invalid" + path, method: "GET", mode, headers }, respondWith: (p: Promise<Response>) => { response = p; }, waitUntil: (_promise: Promise<unknown>) => undefined });
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

const strategies = [
  ["/assets/test.js", "cors"],
  ["/public/model", "cors"],
  ["/", "navigate"],
] as const;
const storageFault = () => new DOMException("Synthetic storage failure", "QuotaExceededError");

describe("optional worker storage failures", () => {
  it.each(strategies)("preserves fresh %s when its cache write fails", async (path, mode) => {
    const w = worker(); await w.message(20_000);
    w.cache.put.mockRejectedValue(storageFault());
    const response = await w.request(path, mode);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("asset");
    expect(w.fetch).toHaveBeenCalledOnce();
  });
  it("does not replace fresh navigation with stale content after a failed write", async () => {
    const w = worker(); await w.message(20_000);
    w.cache.match.mockResolvedValue(new Response("stale"));
    w.cache.put.mockRejectedValue(storageFault());
    expect(await (await w.request("/", "navigate"))?.text()).toBe("asset");
    expect(w.cache.match).not.toHaveBeenCalled();
    expect(w.fetch).toHaveBeenCalledOnce();
  });
  it.each(strategies)("uses one network attempt for %s when opening storage fails", async (path, mode) => {
    const w = worker(); await w.message(20_000);
    w.caches.open.mockRejectedValue(storageFault());
    expect(await (await w.request(path, mode))?.text()).toBe("asset");
    expect(w.fetch).toHaveBeenCalledOnce();
    expect(w.cache.match).not.toHaveBeenCalled();
    expect(w.cache.put).not.toHaveBeenCalled();
  });
  it.each(strategies)("isolates read failures for %s", async (path, mode) => {
    const w = worker(); await w.message(20_000);
    w.cache.match.mockRejectedValue(storageFault());
    expect(await (await w.request(path, mode))?.text()).toBe("asset");
    expect(w.fetch).toHaveBeenCalledOnce();
  });
  it.each(strategies)("rejects prohibited cached %s even when eviction fails", async (path, mode) => {
    const w = worker(); await w.message(20_000);
    w.cache.match.mockImplementation(async () => new Response("prohibited", { headers: { "cache-control": "no-store" } }));
    w.cache.delete.mockRejectedValue(storageFault());
    expect(await (await w.request(path, mode))?.text()).toBe("asset");
    expect(w.fetch).toHaveBeenCalledOnce();
  });
  it.each(strategies)("preserves no-store network %s despite failed cleanup", async (path, mode) => {
    const w = worker(); await w.message(20_000);
    w.fetch.mockImplementation(async () => new Response("fresh-private", { headers: { "cache-control": "no-store" } }));
    w.cache.delete.mockRejectedValue(storageFault());
    expect(await (await w.request(path, mode))?.text()).toBe("fresh-private");
    expect(w.fetch).toHaveBeenCalledOnce();
    expect(w.cache.put).not.toHaveBeenCalled();
  });
  it.each(strategies)("returns a controlled error for %s when both dependencies fail", async (path, mode) => {
    const w = worker(); await w.message(20_000);
    w.caches.open.mockRejectedValue(storageFault());
    w.fetch.mockRejectedValue(new TypeError("Synthetic network failure"));
    expect((await w.request(path, mode))?.type).toBe("error");
    expect(w.fetch).toHaveBeenCalledOnce();
  });
  it.each(strategies)("does not leak a failed %s cache read during an outage", async (path, mode) => {
    const w = worker(); await w.message(20_000);
    w.cache.match.mockRejectedValue(storageFault());
    w.fetch.mockRejectedValue(new TypeError("Synthetic network failure"));
    expect((await w.request(path, mode))?.type).toBe("error");
    expect(w.fetch).toHaveBeenCalledOnce(); expect(w.cache.put).not.toHaveBeenCalled();
  });
  it.each(strategies)("does not return no-store cached %s on network failure", async (path, mode) => {
    const w = worker(); await w.message(20_000);
    w.cache.match.mockImplementation(async () => new Response("prohibited", { headers: { "cache-control": "no-store" } }));
    w.cache.delete.mockRejectedValue(storageFault());
    w.fetch.mockRejectedValue(new TypeError("Synthetic network failure"));
    expect((await w.request(path, mode))?.type).toBe("error");
    expect(w.fetch).toHaveBeenCalledOnce();
    expect(w.cache.put).not.toHaveBeenCalled();
  });
  it.each(strategies)("retains valid cached %s during a network outage", async (path, mode) => {
    const w = worker(); await w.message(20_000);
    w.cache.match.mockImplementation(async () => new Response("safe-cached"));
    w.fetch.mockRejectedValue(new TypeError("Synthetic network failure"));
    expect(await (await w.request(path, mode))?.text()).toBe("safe-cached");
    expect(w.fetch.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it("uses only a permitted valid navigation fallback after a failed exact lookup", async () => {
    const w = worker(); await w.message(20_000);
    w.cache.match.mockImplementation(async key => key === "/" ? new Response("safe-fallback") : undefined);
    w.fetch.mockRejectedValue(new TypeError("Synthetic network failure"));
    expect(await (await w.request("/", "navigate"))?.text()).toBe("safe-fallback");
    expect(w.fetch).toHaveBeenCalledOnce();
  });
  it.each(strategies)("keeps denial/expiry and request no-store authoritative for %s", async (path, mode) => {
    const w = worker(); w.caches.open.mockRejectedValue(storageFault());
    expect(w.request(path, mode)).toBeUndefined();
    await w.message(20_000);
    expect(w.request(path, mode, new Headers({ "cache-control": "no-store" }))).toBeUndefined();
    w.expire(); expect(w.request(path, mode)).toBeUndefined();
    expect(w.caches.open).not.toHaveBeenCalled();
    expect(w.fetch).not.toHaveBeenCalled();
  });
  it.each(strategies)("never reads or writes late %s after withdrawal during a failed open", async (path, mode) => {
    const w = worker(); let rejectOpen!: (error: Error) => void;
    w.caches.open.mockImplementation(() => new Promise((_resolve, reject) => { rejectOpen = reject; }));
    await w.message(20_000); const response = w.request(path, mode);
    await w.message(0); rejectOpen(storageFault());
    expect(await (await response)?.text()).toBe("asset");
    expect(w.fetch).toHaveBeenCalledOnce();
    expect(w.cache.match).not.toHaveBeenCalled(); expect(w.cache.put).not.toHaveBeenCalled();
  });
  it.each(strategies)("isolates storage faults for legacy %s workers too", async (path, mode) => {
    const w = worker(false); w.cache.put.mockRejectedValue(storageFault());
    expect(await (await w.request(path, mode))?.text()).toBe("asset");
    expect(w.fetch).toHaveBeenCalledOnce();
  });
  it("settles a cached stale refresh when its background write rejects", async () => {
    const w = worker(); await w.message(20_000);
    w.cache.match.mockResolvedValue(new Response("safe-cached"));
    w.cache.put.mockRejectedValue(storageFault());
    expect(await (await w.request("/public/model"))?.text()).toBe("safe-cached");
    await vi.waitFor(() => expect(w.cache.put).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(w.fetch).toHaveBeenCalledOnce();
  });
  it.each(strategies)("rejects a cached %s value arriving after consent expires", async (path, mode) => {
    const w = worker(); await w.message(20_000);
    w.cache.match.mockImplementation(async () => { w.expire(); return new Response("expired"); });
    w.fetch.mockRejectedValue(new TypeError("Synthetic network failure"));
    expect((await w.request(path, mode))?.type).toBe("error");
    expect(w.cache.put).not.toHaveBeenCalled();
    expect(w.fetch).toHaveBeenCalledOnce();
  });
  it("retains online delivery if post-withdrawal cache cleanup rejects", async () => {
    const w = worker(); let opened!: (value: typeof w.cache) => void;
    w.caches.open.mockImplementation(() => new Promise(resolve => { opened = resolve; }));
    await w.message(20_000); const pending = w.request();
    await w.message(0); w.caches.delete.mockRejectedValue(storageFault());
    opened(w.cache);
    expect(await (await pending)?.text()).toBe("asset");
    expect(w.cache.match).not.toHaveBeenCalled(); expect(w.cache.put).not.toHaveBeenCalled();
    expect(w.fetch).toHaveBeenCalledOnce();
  });
});
