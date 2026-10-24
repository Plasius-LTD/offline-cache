import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createOfflineCacheWorkerScript } from "../src/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function storage() {
  let stored: Response | undefined = new Response("cached");
  const cache = {
    match: vi.fn(async (): Promise<Response | undefined> => stored?.clone()),
    put: vi.fn(async (_request: unknown, response: Response) => { stored = response.clone(); }),
    delete: vi.fn(async () => { stored = undefined; return true; }),
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ["plasius-offline-public-test"]),
    delete: vi.fn(async () => { stored = undefined; return true; }),
  };
  return { cache, caches };
}

function worker(shared = storage(), requireConsent = true) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const fetch = vi.fn(async (_request: unknown) => new Response("network"));
  let time = 1_000;
  runInNewContext(createOfflineCacheWorkerScript({
    buildId: "test", requireConsent,
    policy: { publicAssetPathPrefixes: ["/public/"], deniedPathPrefixes: ["/public/private/"] },
  }), {
    self: {
      location: { origin: "https://example.invalid" },
      addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener; },
    },
    caches: shared.caches, fetch, URL, Response, Date: { now: () => time },
  });
  const grant = async (allowedUntil = 20_000) => {
    let completion = Promise.resolve();
    listeners.message!({
      data: { type: "plasius-offline-consent-v1", allowedUntil },
      source: { url: "https://example.invalid/" },
      waitUntil: (promise: Promise<void>) => { completion = promise; },
    });
    await completion;
  };
  const request = (path = "/public/model", headers = new Headers()) => {
    let active = true;
    let response: Promise<Response> | undefined;
    const waits: Promise<void>[] = [];
    const waitUntil = vi.fn((promise: Promise<void>) => {
      // Reject a first lifetime registration deferred beyond event dispatch.
      if (!active) throw new DOMException("Event dispatch ended", "InvalidStateError");
      waits.push(promise);
    });
    listeners.fetch!({
      request: { url: "https://example.invalid" + path, method: "GET", headers },
      respondWith: (promise: Promise<Response>) => { response = promise; }, waitUntil,
    });
    active = false;
    return { response, waits, waitUntil };
  };
  return { ...shared, fetch, grant, request, expire: () => { time = 30_000; } };
}

describe("stale refresh fetch-event lifetime", () => {
  it("registers its completion synchronously before the cache opens", async () => {
    const w = worker(); await w.grant();
    const opened = deferred<typeof w.cache>();
    w.caches.open.mockReturnValue(opened.promise);
    const event = w.request();
    expect(event.waitUntil).toHaveBeenCalledOnce();
    expect(w.fetch).not.toHaveBeenCalled();
    opened.resolve(w.cache);
    expect(await (await event.response)?.text()).toBe("cached");
    await event.waits[0];
    expect(w.cache.put).toHaveBeenCalledOnce();
  });

  it("serves cached data while network and then cache write remain pending", async () => {
    const w = worker(); await w.grant();
    const network = deferred<Response>();
    const write = deferred<void>();
    const writing = deferred<void>();
    w.fetch.mockReturnValue(network.promise);
    w.cache.put.mockImplementation(async () => { writing.resolve(); await write.promise; });
    const event = w.request();
    expect(event.waits).toHaveLength(1);
    let completed = false;
    void event.waits[0]!.then(() => { completed = true; });
    expect(await (await event.response)?.text()).toBe("cached");
    expect(w.fetch).toHaveBeenCalledOnce();
    expect(w.cache.put).not.toHaveBeenCalled();
    expect(completed).toBe(false);
    network.resolve(new Response("fresh"));
    await writing.promise;
    expect(completed).toBe(false);
    write.resolve();
    await event.waits[0];
    expect(completed).toBe(true);
    expect(await w.cache.put.mock.calls[0]![1].text()).toBe("fresh");
  });

  it("includes no-store eviction in completion without delaying cached delivery", async () => {
    const w = worker(); await w.grant();
    const network = deferred<Response>();
    const eviction = deferred<boolean>();
    const deleting = deferred<void>();
    w.fetch.mockReturnValue(network.promise);
    w.cache.delete.mockImplementation(() => { deleting.resolve(); return eviction.promise; });
    const event = w.request();
    expect(event.waits).toHaveLength(1);
    let completed = false;
    void event.waits[0]!.then(() => { completed = true; });
    expect(await (await event.response)?.text()).toBe("cached");
    network.resolve(new Response("no-store", { headers: { "cache-control": "no-store" } }));
    await deleting.promise;
    expect(completed).toBe(false);
    expect(w.cache.put).not.toHaveBeenCalled();
    eviction.resolve(true);
    await event.waits[0];
    expect(completed).toBe(true);
  });

  it.each([true, false])("settles rejected fetch/write/eviction without unhandled rejection (hit=%s)", async hit => {
    for (const fault of ["fetch", "put", "delete"] as const) {
      const w = worker(); await w.grant();
      if (!hit) w.cache.match.mockResolvedValue(undefined);
      if (fault === "fetch") w.fetch.mockRejectedValue(new TypeError("Synthetic network failure"));
      else {
        w.cache[fault].mockRejectedValue(new DOMException("Synthetic storage failure", "QuotaExceededError"));
        if (fault === "delete") w.fetch.mockResolvedValue(new Response("network", { headers: { "cache-control": "no-store" } }));
      }
      const event = w.request();
      expect(event.waits).toHaveLength(1);
      const response = await event.response;
      if (hit) expect(await response?.text()).toBe("cached");
      else if (fault === "fetch") expect(response?.type).toBe("error");
      else expect(await response?.text()).toBe("network");
      await expect(event.waits[0]).resolves.toBeUndefined();
      expect(w.fetch).toHaveBeenCalledOnce();
    }
  });

  it("covers a cache miss through deferred fetch and write completion", async () => {
    const w = worker(); await w.grant();
    w.cache.match.mockResolvedValue(undefined);
    const network = deferred<Response>();
    const write = deferred<void>();
    const writing = deferred<void>();
    w.fetch.mockReturnValue(network.promise);
    w.cache.put.mockImplementation(async () => { writing.resolve(); await write.promise; });
    const event = w.request();
    expect(event.waits).toHaveLength(1);
    let completed = false;
    void event.waits[0]!.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    network.resolve(new Response("fresh"));
    await writing.promise;
    expect(completed).toBe(false);
    write.resolve();
    expect(await (await event.response)?.text()).toBe("fresh");
    await event.waits[0];
    expect(completed).toBe(true);
    expect(w.fetch).toHaveBeenCalledOnce();
  });

  it.each(["withdraw", "expire", "withdraw-and-renew"])("prevents late refresh writes after %s", async change => {
    const w = worker(); await w.grant();
    const network = deferred<Response>();
    w.fetch.mockReturnValue(network.promise);
    const event = w.request();
    expect(event.waits).toHaveLength(1);
    expect(await (await event.response)?.text()).toBe("cached");
    if (change === "expire") w.expire();
    else { await w.grant(0); if (change === "withdraw-and-renew") await w.grant(); }
    network.resolve(new Response("late"));
    await event.waits[0];
    expect(w.cache.put).not.toHaveBeenCalled();
    expect(w.fetch).toHaveBeenCalledOnce();
  });

  it("starts denied after restart and requires a fresh lease before cached reuse", async () => {
    const shared = storage();
    const first = worker(shared); await first.grant();
    const firstEvent = first.request();
    expect(firstEvent.waits).toHaveLength(1);
    await firstEvent.response; await firstEvent.waits[0];
    const restarted = worker(shared);
    shared.caches.open.mockClear(); shared.cache.match.mockClear();
    const denied = restarted.request();
    expect(denied.response).toBeUndefined(); expect(denied.waits).toHaveLength(0);
    expect(shared.caches.open).not.toHaveBeenCalled(); expect(shared.cache.match).not.toHaveBeenCalled();
    await restarted.grant();
    const network = deferred<Response>(); restarted.fetch.mockReturnValue(network.promise);
    const renewed = restarted.request();
    expect(renewed.waits).toHaveLength(1);
    expect(await (await renewed.response)?.text()).toBe("network");
    network.resolve(new Response("after-restart")); await renewed.waits[0];
    expect(await (await shared.cache.match())?.text()).toBe("after-restart");
  });

  it("preserves legacy worker refresh completion without consent messaging", async () => {
    const w = worker(storage(), false);
    const network = deferred<Response>(); w.fetch.mockReturnValue(network.promise);
    const event = w.request();
    expect(event.waits).toHaveLength(1);
    expect(await (await event.response)?.text()).toBe("cached");
    network.resolve(new Response("fresh")); await event.waits[0];
    expect(w.cache.put).toHaveBeenCalledOnce();
  });

  it("does not extend or intercept denied, expired, no-store or protected requests", async () => {
    const w = worker();
    const denied = w.request();
    await w.grant();
    const noStore = w.request("/public/model", new Headers({ "cache-control": "no-store" }));
    const protectedPath = w.request("/public/private/secret");
    w.expire(); const expired = w.request();
    for (const event of [denied, noStore, protectedPath, expired]) {
      expect(event.response).toBeUndefined(); expect(event.waitUntil).not.toHaveBeenCalled();
    }
    expect(w.caches.open).not.toHaveBeenCalled(); expect(w.fetch).not.toHaveBeenCalled();
  });
});
