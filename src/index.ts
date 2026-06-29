export type OfflineCacheStatus =
  | "unsupported"
  | "idle"
  | "warming"
  | "ready"
  | "partial"
  | "quota-risk"
  | "offline"
  | "error";

export type OfflineCacheStrategy =
  | "cache-first"
  | "stale-while-revalidate"
  | "network-first"
  | "no-cache";

export interface OfflineCacheLogger {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface OfflineCacheAssetPack {
  readonly id: string;
  readonly revision: string;
  readonly urls: readonly string[];
  readonly estimatedBytes?: number;
}

export interface OfflineCacheUrlResult {
  readonly url: string;
  readonly cached: boolean;
  readonly error?: string;
}

export interface OfflineCacheAssetPackResult {
  readonly id: string;
  readonly revision: string;
  readonly status: OfflineCacheStatus;
  readonly cacheName?: string;
  readonly cachedUrls: number;
  readonly totalUrls: number;
  readonly results: OfflineCacheUrlResult[];
  readonly estimatedBytes?: number;
  readonly availableBytes?: number;
  readonly error?: string;
}

export interface OfflineCacheRequestPolicy {
  readonly sameOriginOnly?: boolean;
  readonly publicNavigationPaths?: readonly string[];
  readonly immutableAssetPathPrefixes?: readonly string[];
  readonly publicAssetPathPrefixes?: readonly string[];
  readonly publicApiPathPrefixes?: readonly string[];
  readonly deniedPathPrefixes?: readonly string[];
  readonly deniedPathPatterns?: readonly RegExp[];
}

export interface OfflineCacheRequestDecision {
  readonly cacheable: boolean;
  readonly strategy: OfflineCacheStrategy;
  readonly reason: string;
  readonly cacheBucket?: "navigation" | "immutable" | "public-asset" | "public-api";
}

export interface RegisterOfflineCacheWorkerOptions {
  readonly workerUrl?: string;
  readonly scope?: string;
  readonly buildId?: string;
  readonly enabled?: boolean;
  readonly logger?: OfflineCacheLogger;
  readonly serviceWorkerContainer?: ServiceWorkerContainer;
}

export interface RegisterOfflineCacheWorkerResult {
  readonly status: "registered" | "unsupported" | "disabled" | "error";
  readonly registration?: ServiceWorkerRegistration;
  readonly error?: unknown;
}

export interface OfflineCacheRuntime {
  readonly caches?: CacheStorage;
  readonly fetch?: typeof fetch;
  readonly location?: Pick<Location, "origin">;
  readonly navigatorStorage?: StorageManager;
}

export interface OfflineCacheOperationOptions extends OfflineCacheRuntime {
  readonly cachePrefix?: string;
  readonly logger?: OfflineCacheLogger;
  readonly quotaRiskRatio?: number;
  readonly signal?: AbortSignal;
}

export interface OfflineCacheWorkerScriptOptions {
  readonly cachePrefix?: string;
  readonly buildId: string;
  readonly policy: OfflineCacheRequestPolicy;
  readonly navigationFallbackUrl?: string;
}

export const DEFAULT_OFFLINE_CACHE_PREFIX = "plasius-offline";

export const DEFAULT_OFFLINE_CACHE_POLICY: Required<
  Pick<
    OfflineCacheRequestPolicy,
    | "sameOriginOnly"
    | "publicNavigationPaths"
    | "immutableAssetPathPrefixes"
    | "publicAssetPathPrefixes"
    | "publicApiPathPrefixes"
    | "deniedPathPrefixes"
  >
> & Pick<OfflineCacheRequestPolicy, "deniedPathPatterns"> = Object.freeze({
  sameOriginOnly: true,
  publicNavigationPaths: Object.freeze(["/"]),
  immutableAssetPathPrefixes: Object.freeze(["/assets/", "/favicon", "/manifest.json"]),
  publicAssetPathPrefixes: Object.freeze([]),
  publicApiPathPrefixes: Object.freeze([]),
  deniedPathPrefixes: Object.freeze([
    "/api/admin",
    "/api/ai",
    "/api/analytics",
    "/api/auth",
    "/api/game",
    "/api/oauth",
    "/api/player-system",
    "/api/profile",
    "/api/users",
    "/api/voice",
    "/admin",
    "/oauth",
    "/profile",
    "/player-system",
  ]),
  deniedPathPatterns: Object.freeze([]),
});

const SAFE_CACHE_SEGMENT_PATTERN = /[^a-z0-9._-]+/giu;
const DEFAULT_QUOTA_RISK_RATIO = 0.9;

function sanitizeCacheSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(SAFE_CACHE_SEGMENT_PATTERN, "-")
    .replace(/^-+|-+$/gu, "");
  return sanitized || "default";
}

function resolveCacheStorage(runtime?: OfflineCacheRuntime): CacheStorage | undefined {
  return runtime?.caches ?? globalThis.caches;
}

function resolveFetch(runtime?: OfflineCacheRuntime): typeof fetch | undefined {
  return runtime?.fetch ?? globalThis.fetch;
}

function resolveNavigatorStorage(
  runtime?: OfflineCacheRuntime,
): StorageManager | undefined {
  return runtime?.navigatorStorage ?? globalThis.navigator?.storage;
}

function resolveBaseOrigin(runtime?: OfflineCacheRuntime): string {
  return runtime?.location?.origin ?? globalThis.location?.origin ?? "https://plasius.co.uk";
}

function normalizeUrl(value: string, runtime?: OfflineCacheRuntime): string {
  return new URL(value, resolveBaseOrigin(runtime)).toString();
}

function toUrl(input: RequestInfo | URL, runtime?: OfflineCacheRuntime): URL | null {
  try {
    if (typeof input === "string") {
      return new URL(input, resolveBaseOrigin(runtime));
    }

    if (input instanceof URL) {
      return input;
    }

    const requestUrl = (input as Request).url;
    return typeof requestUrl === "string"
      ? new URL(requestUrl, resolveBaseOrigin(runtime))
      : null;
  } catch {
    return null;
  }
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET"))
    .toString()
    .toUpperCase();
}

function pathStartsWith(pathname: string, prefixes: readonly string[] = []): boolean {
  return prefixes.some(prefix => pathname === prefix || pathname.startsWith(prefix));
}

function isNavigationRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.headers) {
    const headers = new Headers(init.headers);
    if (headers.get("accept")?.includes("text/html")) {
      return true;
    }
  }

  return typeof input === "object" && "mode" in input && input.mode === "navigate";
}

export function buildOfflineAssetCacheName(
  pack: Pick<OfflineCacheAssetPack, "id" | "revision">,
  cachePrefix = DEFAULT_OFFLINE_CACHE_PREFIX,
): string {
  return [
    sanitizeCacheSegment(cachePrefix),
    "asset-pack",
    sanitizeCacheSegment(pack.id),
    sanitizeCacheSegment(pack.revision),
  ].join("-");
}

export function classifyOfflineCacheRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
  policy: OfflineCacheRequestPolicy = DEFAULT_OFFLINE_CACHE_POLICY,
  runtime?: OfflineCacheRuntime,
): OfflineCacheRequestDecision {
  const method = getRequestMethod(input, init);
  if (method !== "GET" && method !== "HEAD") {
    return { cacheable: false, strategy: "no-cache", reason: "non-get-request" };
  }

  const url = toUrl(input, runtime);
  if (!url) {
    return { cacheable: false, strategy: "no-cache", reason: "invalid-url" };
  }

  const sameOriginOnly = policy.sameOriginOnly ?? DEFAULT_OFFLINE_CACHE_POLICY.sameOriginOnly;
  if (sameOriginOnly && url.origin !== resolveBaseOrigin(runtime)) {
    return { cacheable: false, strategy: "no-cache", reason: "cross-origin" };
  }

  const pathname = url.pathname;
  if ((policy.deniedPathPatterns ?? []).some(pattern => pattern.test(pathname))) {
    return { cacheable: false, strategy: "no-cache", reason: "denied-path-pattern" };
  }

  if (
    pathStartsWith(
      pathname,
      policy.deniedPathPrefixes ?? DEFAULT_OFFLINE_CACHE_POLICY.deniedPathPrefixes,
    )
  ) {
    return { cacheable: false, strategy: "no-cache", reason: "denied-path-prefix" };
  }

  if (pathStartsWith(pathname, policy.publicApiPathPrefixes)) {
    return {
      cacheable: true,
      strategy: "stale-while-revalidate",
      reason: "public-api",
      cacheBucket: "public-api",
    };
  }

  if (pathStartsWith(pathname, policy.publicAssetPathPrefixes)) {
    return {
      cacheable: true,
      strategy: "stale-while-revalidate",
      reason: "public-asset",
      cacheBucket: "public-asset",
    };
  }

  if (
    pathStartsWith(
      pathname,
      policy.immutableAssetPathPrefixes
        ?? DEFAULT_OFFLINE_CACHE_POLICY.immutableAssetPathPrefixes,
    )
  ) {
    return {
      cacheable: true,
      strategy: "cache-first",
      reason: "immutable-asset",
      cacheBucket: "immutable",
    };
  }

  if (
    isNavigationRequest(input, init)
    && (policy.publicNavigationPaths ?? DEFAULT_OFFLINE_CACHE_POLICY.publicNavigationPaths)
      .includes(pathname)
  ) {
    return {
      cacheable: true,
      strategy: "network-first",
      reason: "public-navigation",
      cacheBucket: "navigation",
    };
  }

  return { cacheable: false, strategy: "no-cache", reason: "unmatched" };
}

async function resolveAvailableBytes(
  pack: OfflineCacheAssetPack,
  options: OfflineCacheOperationOptions,
): Promise<number | undefined> {
  if (typeof pack.estimatedBytes !== "number" || pack.estimatedBytes <= 0) {
    return undefined;
  }

  try {
    const estimate = await resolveNavigatorStorage(options)?.estimate?.();
    if (
      typeof estimate?.quota !== "number"
      || typeof estimate.usage !== "number"
      || estimate.quota <= estimate.usage
    ) {
      return undefined;
    }

    return estimate.quota - estimate.usage;
  } catch (error) {
    options.logger?.debug?.("offline cache quota estimate unavailable", { error });
    return undefined;
  }
}

function resultStatus(results: readonly OfflineCacheUrlResult[]): OfflineCacheStatus {
  const cachedCount = results.filter(result => result.cached).length;
  if (cachedCount === results.length) {
    return "ready";
  }
  if (cachedCount > 0) {
    return "partial";
  }
  if (results.some(result => result.error === "offline")) {
    return "offline";
  }
  return "error";
}

export async function warmAssetPack(
  pack: OfflineCacheAssetPack,
  options: OfflineCacheOperationOptions = {},
): Promise<OfflineCacheAssetPackResult> {
  const cacheStorage = resolveCacheStorage(options);
  const fetchImpl = resolveFetch(options);
  const totalUrls = pack.urls.length;
  const cacheName = buildOfflineAssetCacheName(pack, options.cachePrefix);

  if (!cacheStorage || typeof fetchImpl !== "function") {
    return {
      id: pack.id,
      revision: pack.revision,
      status: "unsupported",
      cachedUrls: 0,
      totalUrls,
      results: [],
      estimatedBytes: pack.estimatedBytes,
    };
  }

  if (totalUrls === 0) {
    return {
      id: pack.id,
      revision: pack.revision,
      status: "idle",
      cacheName,
      cachedUrls: 0,
      totalUrls,
      results: [],
      estimatedBytes: pack.estimatedBytes,
    };
  }

  const availableBytes = await resolveAvailableBytes(pack, options);
  const riskRatio = options.quotaRiskRatio ?? DEFAULT_QUOTA_RISK_RATIO;
  if (
    typeof availableBytes === "number"
    && typeof pack.estimatedBytes === "number"
    && pack.estimatedBytes > availableBytes * riskRatio
  ) {
    return {
      id: pack.id,
      revision: pack.revision,
      status: "quota-risk",
      cacheName,
      cachedUrls: 0,
      totalUrls,
      results: [],
      estimatedBytes: pack.estimatedBytes,
      availableBytes,
    };
  }

  const cache = await cacheStorage.open(cacheName);
  const results: OfflineCacheUrlResult[] = [];

  for (const rawUrl of pack.urls) {
    const url = normalizeUrl(rawUrl, options);
    try {
      options.signal?.throwIfAborted();
      const request = new Request(url, {
        method: "GET",
        credentials: "same-origin",
        cache: "reload",
      });
      const response = await fetchImpl(request);
      if (!response.ok) {
        const existing = await cache.match(url);
        results.push({
          url,
          cached: Boolean(existing),
          error: existing ? undefined : `http-${response.status}`,
        });
        continue;
      }

      await cache.put(url, response.clone());
      results.push({ url, cached: true });
    } catch (error) {
      const existing = await cache.match(url);
      const isOffline =
        typeof globalThis.navigator !== "undefined" && globalThis.navigator.onLine === false;
      results.push({
        url,
        cached: Boolean(existing),
        error: existing ? undefined : isOffline ? "offline" : String(error),
      });
    }
  }

  return {
    id: pack.id,
    revision: pack.revision,
    status: resultStatus(results),
    cacheName,
    cachedUrls: results.filter(result => result.cached).length,
    totalUrls,
    results,
    estimatedBytes: pack.estimatedBytes,
    availableBytes,
  };
}

export async function getAssetPackStatus(
  pack: OfflineCacheAssetPack,
  options: OfflineCacheOperationOptions = {},
): Promise<OfflineCacheAssetPackResult> {
  const cacheStorage = resolveCacheStorage(options);
  const totalUrls = pack.urls.length;
  const cacheName = buildOfflineAssetCacheName(pack, options.cachePrefix);

  if (!cacheStorage) {
    return {
      id: pack.id,
      revision: pack.revision,
      status: "unsupported",
      cachedUrls: 0,
      totalUrls,
      results: [],
      estimatedBytes: pack.estimatedBytes,
    };
  }

  if (totalUrls === 0) {
    return {
      id: pack.id,
      revision: pack.revision,
      status: "idle",
      cacheName,
      cachedUrls: 0,
      totalUrls,
      results: [],
      estimatedBytes: pack.estimatedBytes,
    };
  }

  const cache = await cacheStorage.open(cacheName);
  const results = await Promise.all(
    pack.urls.map(async rawUrl => {
      const url = normalizeUrl(rawUrl, options);
      return {
        url,
        cached: Boolean(await cache.match(url)),
      };
    }),
  );

  return {
    id: pack.id,
    revision: pack.revision,
    status: resultStatus(results),
    cacheName,
    cachedUrls: results.filter(result => result.cached).length,
    totalUrls,
    results,
    estimatedBytes: pack.estimatedBytes,
  };
}

export async function clearOfflineCaches(options: {
  readonly cachePrefix?: string;
  readonly caches?: CacheStorage;
} = {}): Promise<string[]> {
  const cacheStorage = options.caches ?? globalThis.caches;
  if (!cacheStorage) {
    return [];
  }

  const prefix = sanitizeCacheSegment(options.cachePrefix ?? DEFAULT_OFFLINE_CACHE_PREFIX);
  const cacheNames = await cacheStorage.keys();
  const deleted: string[] = [];
  for (const cacheName of cacheNames) {
    if (cacheName.startsWith(prefix) && await cacheStorage.delete(cacheName)) {
      deleted.push(cacheName);
    }
  }
  return deleted;
}

export async function registerOfflineCacheWorker(
  options: RegisterOfflineCacheWorkerOptions = {},
): Promise<RegisterOfflineCacheWorkerResult> {
  if (options.enabled === false) {
    return { status: "disabled" };
  }

  const serviceWorkerContainer =
    options.serviceWorkerContainer ?? globalThis.navigator?.serviceWorker;
  if (!serviceWorkerContainer) {
    return { status: "unsupported" };
  }

  const workerUrl = new URL(
    options.workerUrl ?? "/offline-cache-worker.js",
    globalThis.location?.origin ?? "https://plasius.co.uk",
  );
  if (options.buildId) {
    workerUrl.searchParams.set("build", options.buildId);
  }

  try {
    const registration = await serviceWorkerContainer.register(workerUrl.toString(), {
      scope: options.scope ?? "/",
    });
    options.logger?.info?.("offline cache worker registered", {
      workerUrl: workerUrl.pathname,
      scope: registration.scope,
    });
    return {
      status: "registered",
      registration,
    };
  } catch (error) {
    options.logger?.warn?.("offline cache worker registration failed", { error });
    return {
      status: "error",
      error,
    };
  }
}

export function createOfflineCacheWorkerScript(
  options: OfflineCacheWorkerScriptOptions,
): string {
  const cachePrefix = sanitizeCacheSegment(
    options.cachePrefix ?? DEFAULT_OFFLINE_CACHE_PREFIX,
  );
  const buildId = sanitizeCacheSegment(options.buildId);
  const policyJson = JSON.stringify(options.policy);
  const fallbackUrl = JSON.stringify(options.navigationFallbackUrl ?? "/");

  return `
const CACHE_PREFIX = ${JSON.stringify(cachePrefix)};
const BUILD_ID = ${JSON.stringify(buildId)};
const APP_CACHE = CACHE_PREFIX + "-app-" + BUILD_ID;
const PUBLIC_CACHE = CACHE_PREFIX + "-public-" + BUILD_ID;
const POLICY = ${policyJson};
const NAVIGATION_FALLBACK_URL = ${fallbackUrl};

const startsWithAny = (pathname, prefixes = []) => prefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
const isDenied = (pathname) => startsWithAny(pathname, POLICY.deniedPathPrefixes || []);
const classify = (request) => {
  if (request.method !== "GET" && request.method !== "HEAD") return { cacheable: false, strategy: "no-cache" };
  const url = new URL(request.url);
  if (POLICY.sameOriginOnly !== false && url.origin !== self.location.origin) return { cacheable: false, strategy: "no-cache" };
  if (isDenied(url.pathname)) return { cacheable: false, strategy: "no-cache" };
  if (startsWithAny(url.pathname, POLICY.publicApiPathPrefixes || [])) return { cacheable: true, strategy: "stale-while-revalidate", cacheName: PUBLIC_CACHE };
  if (startsWithAny(url.pathname, POLICY.publicAssetPathPrefixes || [])) return { cacheable: true, strategy: "stale-while-revalidate", cacheName: PUBLIC_CACHE };
  if (startsWithAny(url.pathname, POLICY.immutableAssetPathPrefixes || [])) return { cacheable: true, strategy: "cache-first", cacheName: APP_CACHE };
  if (request.mode === "navigate" && (POLICY.publicNavigationPaths || []).includes(url.pathname)) return { cacheable: true, strategy: "network-first", cacheName: APP_CACHE };
  return { cacheable: false, strategy: "no-cache" };
};

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX + "-") && !name.endsWith("-" + BUILD_ID) && !name.includes("-asset-pack-")).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = (await cache.match(request)) || (await caches.match(request));
  const refresh = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  return cached || refresh;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    return (await cache.match(request)) || (await cache.match(NAVIGATION_FALLBACK_URL)) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const decision = classify(event.request);
  if (!decision.cacheable) return;
  if (decision.strategy === "cache-first") event.respondWith(cacheFirst(event.request, decision.cacheName));
  if (decision.strategy === "stale-while-revalidate") event.respondWith(staleWhileRevalidate(event.request, decision.cacheName));
  if (decision.strategy === "network-first") event.respondWith(networkFirst(event.request, decision.cacheName));
});
`.trimStart();
}
