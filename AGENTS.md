# AGENTS.md

## Scope

This repository is `@plasius/offline-cache`, a browser-side offline cache
package for Plasius progressive public sites and demo asset packs.

## Setup

- Use Node.js 24 and npm.
- Install dependencies with `npm ci`.

## Commands

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run lint`
- `npm run pack:check`

## Conventions

- Source lives in `src/`; tests live in `tests/`.
- Do not cache secrets, authenticated payloads, profile data, admin data, or
  mutation responses.
- Large assets must be stored in CacheStorage, not retained in JavaScript
  memory after warming.
- Keep public APIs typed and documented.
- Update `README.md`, `CHANGELOG.md`, and ADRs for behavior changes.
