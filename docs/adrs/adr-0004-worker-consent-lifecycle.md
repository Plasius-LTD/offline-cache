# ADR 0004: Optional worker storage requires current host permission

Status: Accepted

Consent-aware workers start denied and require a same-origin host permission lease
of at most 60 seconds. The host combines its versioned visitor choice with the
persisted flag `site.privacy.optional-processing.enabled`. Withdrawal invalidates
in-flight cache operations before scoped deletion and acknowledgement. Ordinary
worker generation stays compatible. No identifier or persistent consent copy is
introduced in the worker. A restart/expired lease fails closed; offline operation
is bounded by the lease, so hosts must not promise indefinite offline access.
Legacy controllers require a migration/detachment before revocation is verified.

Tracking: site Feature #2206, Story #2207; offline-cache Task #12.

## Optional storage failure isolation

Task #27 extends the worker boundary to isolate rejected CacheStorage open, read,
write and eviction operations. Cache failures become misses or skipped updates;
they never turn a successful network response into stale content or an error.
Each request makes at most one network attempt. Network-first handles only a
network rejection as an opportunity to use a permitted cached response or the
configured navigation fallback. Exhausted network/cache fallback returns
`Response.error()` without exposing provider exceptions or retrying.

Every cache read/update still checks the current permission generation and lease.
A no-store cached response remains ineligible even when deletion fails. Failed
cleanup does not grant permission to reuse retained data. Successful network
no-store responses reach the caller without being cached. Hosts retain their
existing scoped cleanup/withdrawal acknowledgement responsibilities. The worker
introduces no persisted identifier, new telemetry or additional asset buffer.

The host composes `site.privacy.optional-processing.enabled` with
`site.offline-cache.enabled` and visitor consent; rollback disables optional
processing and withdraws/unregisters the worker. The package does not query the
remote control plane itself or introduce an entitlement capability. Mandatory
consent, deny and no-store checks are unconditional. Existing worker generation
without `requireConsent` also isolates storage failures.

Generated-worker regression tests execute real worker code with CacheStorage
faults and verify response bodies, attempt counts, safe fallbacks, permission
expiry/withdrawal and rejected background writes. This decision addresses
rejections, not permanently pending browser storage operations. Browser-owned
fetch cancellation/lifetime is unchanged; stale-refresh fetch-event lifetime is
tracked separately in Task #28. Release through the existing main CD/OIDC path
before host adoption; no new dependency or public API is required.
