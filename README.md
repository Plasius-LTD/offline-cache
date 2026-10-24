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
artifacts using exact, case-normalised path checks. CI runs only for canonical
repository branch pushes on `Public CI - Quarantined` with literal
`[self-hosted, Linux, X64]` labels. Pull-request and manual triggers are absent.
Both jobs check the repository and event, have bounded timeouts, persist no
checkout credentials and disable package-manager caching. There is no hosted CI
fallback or caller-selected runner. Clean installation, lint, types, runtime
audit, build, 80% line coverage and final package-manifest checks remain required.
Publication uses the GitHub-hosted `production` job with Node 24 and a pinned
npm 11.6.2 client. It is token-free and proceeds only while the prepared SHA
is the exact `main` head after successful push-triggered CI. Do not dispatch CD
until the npm trusted-publisher binding is verified.

An authorised runner-group operator must review each source branch before adding
only `Plasius-LTD/offline-cache/.github/workflows/ci.yml@refs/heads/<branch>`
to the existing workflow allowlist. Preserve repository selection, public access
policy and unrelated refs. Keep the existing `main` admission.
Review the release-preparation App's exact metadata diff before admitting its
branch. Run metadata CI and required reviews/checks before merge where repository
policy holds the PR open. Existing preparation can auto-merge under a policy
without required checks; record that accurately and verify successful metadata
and exact-main CI before publication. If the App deleted the branch, restore only
its reviewed, unchanged PR-head SHA to the same absent branch by an ordinary
non-force push so its queued CI can execute. Remove temporary admissions and
branches after successful checks. Missing access is a blocker; never widen
admission with wildcards or change production/protection settings to pass.

The remote `platform.public-artifact-integrity.enabled` flag controls restoration
of public distribution. Mandatory integrity checks remain unconditional when it
is enabled, disabled or rolled back. Rollback disables the affected workflow or
distribution channel and removes temporary admissions; it never restores the
administrative path or hosted CI. No capability is introduced.
<!-- END PLASIUS RELEASE INTEGRITY -->

## Consent-aware workers

Set `requireConsent: true` when generating a worker for optional caching. It starts
without permission and accepts only same-origin window messages of type
`plasius-offline-consent-v1` with `allowedUntil` (epoch milliseconds). Grants last
at most 60 seconds and must be renewed by a host that still has valid consent and
remote permission. A worker restart starts denied; host permission must be renewed.
Send `allowedUntil: 0` on withdrawal with a MessageChannel to receive the matching
`{ type, disabled: true }` acknowledgement after scoped cache deletion. Pending
responses cannot repopulate discarded caches. Unregister the worker afterwards.
Unregistration alone does not stop an already-controlling worker. Legacy workers
without this protocol must be replaced or detached through navigation before the
host can claim immediate revocation. Offline availability is limited to a current
permission lease; exhausted leases fail closed. Existing generation behaviour is
unchanged when `requireConsent` is omitted.

Use `immutableAssetPathPatterns` for exact content-addressed asset paths. Denied
paths always win; host and generated worker preserve regex source and flags.

`warmAssetPack` propagates its `signal` to downloads and rejects with the abort
reason before further cache access after cancellation, including late responses.
Hosts should treat consent cancellation as a normal stop, not a renderer failure.

## Optional storage failures

Generated workers keep online responses usable when CacheStorage open, read,
write or eviction operations reject, including quota failures. A failed read is a
cache miss; a failed update cannot replace a successful network response with
stale content. Each intercepted request makes at most one network attempt. When
that attempt fails, only a currently permitted cached response/navigation fallback
may be returned; otherwise the worker returns `Response.error()`.

No-store entries remain ineligible even if eviction fails. Consent denial,
expiry and withdrawal still prohibit cache reuse/updates. Storage failures do not
produce provider-error logs or change the host's cleanup acknowledgement duties.
This handles rejected storage operations; permanently pending operations remain
subject to browser limits. Hosts continue to compose stored
`site.privacy.optional-processing.enabled` / `site.offline-cache.enabled` with
visitor consent, and withdraw/unregister the worker when disabled.

Stale-while-revalidate workers synchronously register `event.waitUntil` for the
refresh, including cache lookup, network fetch and cache write/no-store eviction.
A valid cached response is served without waiting for that background work. The
lifetime promise settles after the refresh update completes, including rejected
network/storage operations. It does not extend consent: withdrawal or lease expiry
while the network is pending still prevents a late write, even after a new grant.
A restarted consent-aware worker still starts denied and needs a new host lease.
Browser shutdown/termination behavior and the built site worker are qualified in
the host adoption task; a lifetime promise does not guarantee completion after
browser shutdown.
