# AMS SOFT Status deployment

The owner authorized production deployment before a further production audit on 2026-11-12. This release adds a dedicated operator gateway: local password provisioning, Better Auth 1.7.22, SQLite, authenticator TOTP, secure cookies, one administrator and one-hour sessions. No mail server or public registration/recovery. A first-factor session cannot call connection routes. Enrollment requires the password and a valid TOTP; the browser signs out after enrollment before normal two-factor login.

Only the gateway is public. No general WAHA API, dashboard, chats, WebSocket or arbitrary proxy routes. The operator can start/check the default session and display its pairing QR. This delivery does not add video publication or scheduling. No WhatsApp Status is sent by deployment.

Existing hardening: pinned public IPv4 HTTPS media origin policy, no redirects/proxy, 15-second overall budget, 32 MiB response limit and no media URL fetch in AMSSOFT_STATUS_ONLY mode; legacy session permissions; bounded event authorization and delivery. CI checks project types, 26 targeted security tests and operator login/boundary tests before compiling and publishing a candidate image archive with a SHA256 checksum. Dokploy uses RAW with the immutable commit-tagged local image loaded from that archive. The build runs in GitHub Actions, not on the Dokploy VM.

Runtime base: official GOWS 2026.10.1 pinned by digest. Node application output is rebuilt from this fork. The upstream Go binary and base dependencies remain in use; this is not a complete vulnerability remediation or a source rebuild of GOWS. The untracked local engines/gows tree is not part of this release. The WhatsApp protocol can deliver account messages to a linked device even with no chat interface. No webhooks or message automations are configured; incoming-media download and application message storage are disabled. This does not guarantee that the transport never receives private messages.

Operator state and authentication secrets are persistent private host mounts, never in the repository/image. The administrator must enroll their own authenticator at first login. No automated real-account pairing or publication is performed by tests.

## QR recovery update

A FAILED GOWS session can remain loaded in the manager. The operator now calls restart for FAILED and start only for STOPPED, preserving device credentials and configuration. It returns the observed session state instead of unconditional success, rejects failed retries and serializes concurrent start requests. The browser polls while STARTING/SCAN_QR_CODE, refreshes the QR automatically, stops after WORKING/FAILED, and allows explicit regeneration after expiration through either button. It never performs automatic restart loops.

The new HTML/JavaScript no longer embeds the operator's phone number. Optional expected-number comparison is configured only on the server via OPERATOR_EXPECTED_NUMBER and returned as a boolean after MFA. Earlier commits and previously published image archives can still contain the old value; this update does not purge historical copies.

## HTTP parser audit mitigation

Both JSON middleware instances reject compressed request bodies (`inflate: false`), following the official workaround for CVE-2026-111181 / GHSA-27r3-jxmh-p828 in the inherited body-parser dependency. The browser uses ordinary uncompressed JSON. Benign gzip/deflate/Brotli requests are rejected before decoding; the 4 KiB body limit remains enforced. This mitigation does not update or remove the vulnerable package from the image. The broad base-image dependency remediation is still pending; package scan results must not be described as a clean image.

## Status publication and Postiz bridge

The operator now has a persistent SQLite publication queue, local MP4 catalog, manual/scheduled publication, daily recurrence, and a history distinguishing server confirmation, owner confirmation, preflight waiting and unknown outcomes. It permits only the privately configured account and one active send. Message ids are persisted before calling WhatsApp; uncertain outcomes are never automatically resent. The private media roots are read-only mounts, with traversal/symlink/type/size checks. Automation uses a separate runtime-mounted token; human publication controls remain behind password and TOTP. The Postiz whatsapp-status provider creates idempotent jobs and polls until publication is confirmed. No chat or group send route is exposed.

## Bridge-only publishing contract (2026-11-13)

Postiz owns the calendar and recurrence. The operator has no media catalogue, manual publisher, scheduling endpoint, recurrence settings, local planner or future-dated job API. Its UI provides pairing, protected history and owner reconciliation of an unknown send result.

At publication time, Postiz calls POST /automation/jobs with only id, file (relative to the read-only Postiz upload volume), and optional caption. Any scheduling/additional fields are rejected. The bridge persists the request and sends as soon as the configured account is available; it does not choose a new publication date. GET job status feeds the Postiz pending-publication workflow. Request identity is immutable; independent occurrences are not merged by content/time.

The folder discovery script belongs to Postiz deployment automation, outside this bridge, and creates native Postiz recurring posts. Preserve its existing post IDs/state when moving it. Runtime must not mount the source advertising folder into the operator. Old manual scheduling routes return 404. Legacy database rows/tables may remain for history and rollback but no active code uses them as a calendar.
