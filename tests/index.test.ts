import { describe, expect, it, vi } from "vitest";
import {
  buildOfflineAssetCacheName,
  classifyOfflineCacheRequest,
  clearOfflineCaches,
  createOfflineCacheWorkerScript,
  getAssetPackStatus,
  registerOfflineCacheWorker,
  warmAssetPack,
  type OfflineCacheAssetPack,
} from "../src/index.js";

class MemoryCache {
  readonly entries = new Map<string, Response>();

  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    const key = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    return this.entries.get(key);
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    const key = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    this.entries.set(key, response);
  }
}

class MemoryCacheStorage {
  readonly stores = new Map<string, MemoryCache>();

  async open(name: string): Promise<MemoryCache> {
    const existing = this.stores.get(name);
    if (existing) {
      return existing;
    }
    const cache = new MemoryCache();
    this.stores.set(name, cache);
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

const policy = {
  sameOriginOnly: true,
  publicNavigationPaths: ["/", "/gpu-demo"],
  immutableAssetPathPrefixes: ["/assets/", "/manifest.json", "/favicon"],
  publicAssetPathPrefixes: ["/api/gpu-demo/assets/"],
  publicApiPathPrefixes: ["/api/gpu-demo/runtime"],
  deniedPathPrefixes: ["/api/users", "/api/admin", "/api/player-system", "/api/voice", "/admin"],
};

const runtime = {
  location: {
    origin: "https://plasius.co.uk",
  },
};

describe("offline cache request classifier", () => {
  it("caches only public GET requests from the configured site origin", () => {
    expect(
      classifyOfflineCacheRequest(
        "https://plasius.co.uk/assets/entry-abc.js",
        undefined,
        policy,
        runtime,
      ),
    ).toMatchObject({
      cacheable: true,
      strategy: "cache-first",
      reason: "immutable-asset",
    });

    expect(
      classifyOfflineCacheRequest(
        "https://plasius.co.uk/api/gpu-demo/assets/product-studio/eames/model.gltf",
        undefined,
        policy,
        runtime,
      ),
    ).toMatchObject({
      cacheable: true,
      strategy: "stale-while-revalidate",
      reason: "public-asset",
    });

    expect(
      classifyOfflineCacheRequest(
        "https://plasius.co.uk/gpu-demo",
        { headers: { accept: "text/html" } },
        policy,
        runtime,
      ),
    ).toMatchObject({
      cacheable: true,
      strategy: "network-first",
      reason: "public-navigation",
    });
  });

  it("rejects sensitive, mutating, and cross-origin requests", () => {
    expect(
      classifyOfflineCacheRequest(
        "https://plasius.co.uk/api/users/me",
        undefined,
        policy,
        runtime,
      ),
    ).toMatchObject({ cacheable: false, reason: "denied-path-prefix" });

    expect(
      classifyOfflineCacheRequest(
        "https://plasius.co.uk/api/gpu-demo/assets/product-studio/eames/model.gltf",
        { method: "POST" },
        policy,
        runtime,
      ),
    ).toMatchObject({ cacheable: false, reason: "non-get-request" });

    expect(
      classifyOfflineCacheRequest(
        "https://example.invalid/assets/entry.js",
        undefined,
        policy,
        runtime,
      ),
    ).toMatchObject({ cacheable: false, reason: "cross-origin" });
  });
});

describe("asset pack cache", () => {
  const pack: OfflineCacheAssetPack = {
    id: "product-studio-eames",
    revision: "2026-06-29",
    urls: [
      "/api/gpu-demo/assets/product-studio/eames/model.gltf",
      "/api/gpu-demo/assets/product-studio/eames/texture.png",
    ],
    estimatedBytes: 512,
  };

  it("warms asset packs into CacheStorage and reports ready status", async () => {
    const caches = new MemoryCacheStorage();
    const fetchMock = vi.fn(async () => new Response("asset", { status: 200 }));

    const result = await warmAssetPack(pack, {
      caches: caches as unknown as CacheStorage,
      fetch: fetchMock as unknown as typeof fetch,
      location: runtime.location,
      navigatorStorage: {
        estimate: async () => ({ quota: 10_000, usage: 1_000 }),
      } as StorageManager,
    });

    expect(result).toMatchObject({
      status: "ready",
      cachedUrls: 2,
      totalUrls: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(
      getAssetPackStatus(pack, {
        caches: caches as unknown as CacheStorage,
        location: runtime.location,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      cachedUrls: 2,
    });
  });

  it("returns unsupported or idle when cache primitives or URLs are missing", async () => {
    await expect(
      warmAssetPack(pack, {
        location: runtime.location,
      }),
    ).resolves.toMatchObject({
      status: "unsupported",
      cachedUrls: 0,
    });

    const caches = new MemoryCacheStorage();
    await expect(
      warmAssetPack(
        {
          ...pack,
          urls: [],
        },
        {
          caches: caches as unknown as CacheStorage,
          fetch: vi.fn(async () => new Response("asset", { status: 200 })) as unknown as typeof fetch,
          location: runtime.location,
        },
      ),
    ).resolves.toMatchObject({
      status: "idle",
      cachedUrls: 0,
      totalUrls: 0,
    });

    await expect(
      getAssetPackStatus(
        {
          ...pack,
          urls: [],
        },
        {
          caches: caches as unknown as CacheStorage,
          location: runtime.location,
        },
      ),
    ).resolves.toMatchObject({
      status: "idle",
      cachedUrls: 0,
      totalUrls: 0,
    });
  });

  it("surfaces quota-risk before downloading large packs", async () => {
    const caches = new MemoryCacheStorage();
    const fetchMock = vi.fn(async () => new Response("asset", { status: 200 }));

    const result = await warmAssetPack(
      { ...pack, estimatedBytes: 9_500 },
      {
        caches: caches as unknown as CacheStorage,
        fetch: fetchMock as unknown as typeof fetch,
        location: runtime.location,
        navigatorStorage: {
          estimate: async () => ({ quota: 10_000, usage: 1_000 }),
        } as StorageManager,
      },
    );

    expect(result.status).toBe("quota-risk");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps existing cached assets and reports partial status on upstream failures", async () => {
    const caches = new MemoryCacheStorage();
    const cache = await caches.open(buildOfflineAssetCacheName(pack));
    await cache.put(
      "https://plasius.co.uk/api/gpu-demo/assets/product-studio/eames/model.gltf",
      new Response("cached", { status: 200 }),
    );
    const fetchMock = vi.fn(async () => new Response("downstream unavailable", { status: 503 }));

    const result = await warmAssetPack(pack, {
      caches: caches as unknown as CacheStorage,
      fetch: fetchMock as unknown as typeof fetch,
      location: runtime.location,
    });

    expect(result).toMatchObject({
      status: "partial",
      cachedUrls: 1,
      totalUrls: 2,
    });
    expect(result.results).toEqual([
      {
        url: "https://plasius.co.uk/api/gpu-demo/assets/product-studio/eames/model.gltf",
        cached: true,
      },
      {
        url: "https://plasius.co.uk/api/gpu-demo/assets/product-studio/eames/texture.png",
        cached: false,
        error: "http-503",
      },
    ]);
  });

  it("reports offline when fetch fails and no cached asset is available", async () => {
    const caches = new MemoryCacheStorage();
    const fetchMock = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const logger = {
      debug: vi.fn(),
    };

    vi.stubGlobal("navigator", {
      onLine: false,
    });

    const result = await warmAssetPack(
      {
        ...pack,
        urls: [pack.urls[0]],
      },
      {
        caches: caches as unknown as CacheStorage,
        fetch: fetchMock as unknown as typeof fetch,
        location: runtime.location,
        navigatorStorage: {
          estimate: async () => {
            throw new Error("estimate failed");
          },
        } as StorageManager,
        logger,
      },
    );

    expect(result).toMatchObject({
      status: "offline",
      cachedUrls: 0,
      totalUrls: 1,
    });
    expect(result.results).toEqual([
      {
        url: "https://plasius.co.uk/api/gpu-demo/assets/product-studio/eames/model.gltf",
        cached: false,
        error: "offline",
      },
    ]);
    expect(logger.debug).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("uses revisioned cache names and clears Plasius cache entries", async () => {
    const caches = new MemoryCacheStorage();
    await caches.open(buildOfflineAssetCacheName(pack));
    await caches.open("other-cache");

    await expect(
      clearOfflineCaches({ caches: caches as unknown as CacheStorage }),
    ).resolves.toEqual([buildOfflineAssetCacheName(pack)]);
    await expect(caches.keys()).resolves.toEqual(["other-cache"]);
  });

  it("returns empty results when CacheStorage is unavailable", async () => {
    await expect(clearOfflineCaches()).resolves.toEqual([]);
    await expect(
      getAssetPackStatus(pack, {
        location: runtime.location,
      }),
    ).resolves.toMatchObject({
      status: "unsupported",
      cachedUrls: 0,
    });
  });
});

describe("worker registration and script generation", () => {
  it("registers a versioned service worker when supported", async () => {
    const register = vi.fn(async () => ({ scope: "/" }));

    await expect(
      registerOfflineCacheWorker({
        workerUrl: "/offline-cache-worker.js",
        buildId: "abc123",
        serviceWorkerContainer: { register } as unknown as ServiceWorkerContainer,
      }),
    ).resolves.toMatchObject({ status: "registered" });

    expect(register).toHaveBeenCalledWith(
      "https://plasius.co.uk/offline-cache-worker.js?build=abc123",
      { scope: "/" },
    );
  });

  it("surfaces disabled, unsupported, and failed worker registration states", async () => {
    await expect(
      registerOfflineCacheWorker({
        enabled: false,
      }),
    ).resolves.toEqual({ status: "disabled" });

    await expect(
      registerOfflineCacheWorker({
        serviceWorkerContainer: undefined,
      }),
    ).resolves.toEqual({ status: "unsupported" });

    const logger = {
      warn: vi.fn(),
    };
    const error = new Error("register failed");
    const register = vi.fn(async () => {
      throw error;
    });

    await expect(
      registerOfflineCacheWorker({
        logger,
        serviceWorkerContainer: { register } as unknown as ServiceWorkerContainer,
      }),
    ).resolves.toEqual({
      status: "error",
      error,
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("generates a worker script with public policy and cache cleanup", () => {
    const script = createOfflineCacheWorkerScript({
      buildId: "build-1",
      policy,
    });

    expect(script).toContain("publicApiPathPrefixes");
    expect(script).toContain("self.addEventListener(\"fetch\"");
    expect(script).toContain("caches.delete");
  });
});
