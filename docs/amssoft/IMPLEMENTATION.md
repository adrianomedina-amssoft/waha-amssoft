# Status-only security implementation

Work in progress. Not approved for deployment. Keep the Dokploy service quarantined.

Implemented first patch: fail-closed HTTPS origin policy, public IPv4-only DNS resolution pinned to the actual TLS connection, redirects/proxies disabled, 15-second overall deadline, 32 MiB body limit, Status-only URL refusal; distinct setting/deletion permissions on legacy session mutations. Tests and CI must pass before release.

Remaining: public Status-only module, Better Auth/TOTP/SQLite, private media namespace enforcement, live-subscription revocation, source-built GOWS profile, minimal image and gated publication, isolated regression checks, scan and Dokploy rollout. No production pairing/publication authorized by this patch.

Vendored engines/gows is upstream v1.0.49; preserve its license and provenance. It is not yet wired into the release build.
