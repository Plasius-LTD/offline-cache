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
