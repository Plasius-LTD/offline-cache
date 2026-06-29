# ADR 0001: Browser CacheStorage Package Boundary

- Status: Accepted
- Date: 2026-06-29

## Context

Plasius public demos can depend on large model, buffer, texture, shader, and
route assets. Re-downloading those assets on every visit is wasteful, but
holding them continuously in JavaScript memory is not acceptable.

## Decision

`@plasius/offline-cache` owns reusable browser cache helpers for public,
progressive site surfaces. It uses the browser CacheStorage API as the backing
store, exposes asset-pack warming/status APIs, and provides explicit request
classification for service workers.

Sensitive, authenticated, mutating, and game/API state routes are excluded from
the default cache policy. Consumers must opt public asset prefixes and public
navigation paths into caching.

## Consequences

- Large public demo assets can be reused across visits and offline reloads.
- Runtime memory stays bounded to response streaming and lightweight metadata.
- Site integrations keep their own public-route policy while sharing cache
  primitives and status handling.
