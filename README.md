# @plasius/offline-cache

Browser-side offline cache helpers for Plasius progressive public sites and
demo asset packs.

The package stores responses in the browser CacheStorage API. It does not keep
large model, buffer, texture, or route responses in JavaScript memory after
warming completes.

## Install

```bash
npm install @plasius/offline-cache
```

## Usage

```ts
import {
  registerOfflineCacheWorker,
  warmAssetPack,
} from "@plasius/offline-cache";

await registerOfflineCacheWorker({
  workerUrl: "/offline-cache-worker.js",
  buildId: import.meta.env.VITE_GIT_COMMIT_SHA,
});

await warmAssetPack({
  id: "product-studio-eames",
  revision: "2026-06-29",
  urls: [
    "/api/gpu-demo/assets/product-studio/eames/Eames_Lounge_Chair_Ottoman.gltf",
  ],
  estimatedBytes: 12_000_000,
});
```

## Cache Policy

Use `classifyOfflineCacheRequest` in service workers to keep cache decisions
explicit. The default policy caches public GET requests only and rejects
authenticated, mutating, or sensitive API paths.

## Validation

```bash
npm test
npm run typecheck
npm run build
npm run pack:check
```
