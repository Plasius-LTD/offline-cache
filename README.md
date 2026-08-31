# @plasius/offline-cache

[![npm version](https://img.shields.io/npm/v/@plasius/offline-cache.svg)](https://www.npmjs.com/package/@plasius/offline-cache)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Plasius-LTD/offline-cache/ci.yml?branch=main&label=build&style=flat)](https://github.com/Plasius-LTD/offline-cache/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/codecov/c/github/Plasius-LTD/offline-cache)](https://codecov.io/gh/Plasius-LTD/offline-cache)
[![License](https://img.shields.io/github/license/Plasius-LTD/offline-cache)](./LICENSE)
[![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-yes-blue.svg)](./CODE_OF_CONDUCT.md)
[![Security Policy](https://img.shields.io/badge/security%20policy-yes-orange.svg)](./SECURITY.md)
[![Changelog](https://img.shields.io/badge/changelog-md-blue.svg)](./CHANGELOG.md)

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

Requests or responses containing the RFC 9111 `Cache-Control: no-store`
directive are never stored or reused. The generated worker also removes legacy
entries carrying that directive before serving them.

Runtime rollout inherits `governance.rfc-compliance-remediation.enabled`.
Enabled consumers use the corrected worker; rollback disables the flag and
restores the prior worker registration. No-store responses have no permissive
fallback because retaining them would violate the origin's storage directive.

## Validation

```bash
npm test
npm run typecheck
npm run build
npm run pack:check
```

<!-- BEGIN PLASIUS RELEASE INTEGRITY -->
## Release integrity

CI keeps the administrative contributor registry outside Git and npm package
artifacts using exact, case-normalised path checks. CI runs on approved
self-hosted runners. Release preparation and npm publication use GitHub-hosted
runners with Node.js 24.18.0 LTS. CD remains disabled until the npm trusted
publisher binding is verified and the legacy token fallback is removed.
<!-- END PLASIUS RELEASE INTEGRITY -->
