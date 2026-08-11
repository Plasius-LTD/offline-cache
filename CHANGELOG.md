# Changelog

## Unreleased

- **Added**
  - (placeholder)

- **Changed**
  - Bound npm publication to the exact prepared `main` commit after successful push-triggered CI.
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - Removed the npm write-token path, added a fail-closed npm 11.5.1-or-newer OIDC guard, and denied fork PR code access to self-hosted CI.
  - Added fail-closed source and npm-package admission for the administrative contributor registry and pinned the CI/CD runtime to Node.js 24.18.0 LTS.
  - (placeholder)

## [0.1.1] - 2026-07-12

- Refuse storage and reuse of requests or responses carrying RFC 9111
  `Cache-Control: no-store`, including generated service-worker strategies and
  asset-pack warming.

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [0.1.0] - 2026-06-29

- Added the initial browser offline cache package with service-worker
  registration, request classification, CacheStorage asset-pack warming,
  status checks, quota guards, cache cleanup, and worker-script generation.


[0.1.0]: https://github.com/Plasius-LTD/offline-cache/releases/tag/v0.1.0
[0.1.1]: https://github.com/Plasius-LTD/offline-cache/releases/tag/v0.1.1
