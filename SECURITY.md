# Security

## No transport encryption

This app has no TLS termination built in — it's plain HTTP, full stop. Anyone who can
observe traffic between a client and wherever this is running can read everything on the
wire, including the `STUDIO_API_TOKEN` bearer token if one is set. Binding to loopback
keeps that traffic on the machine itself; the moment `BIND_ADDRESS` (or an equivalent) puts
this on any network, even one you trust, that traffic is unencrypted on it. If you need to
reach this from another device, put a reverse proxy or a VPN in front of it that terminates
TLS — don't rely on the app for that, it doesn't do it.

Whether the port is reachable beyond your own network at all — firewall rules, port
forwarding, cloud security groups — is a deployment concern outside this app's own config.
The loopback-by-default binding is a safe starting point, not a guarantee of anything past
your own machine.

## Known risks accepted by design

These are real, reviewed, and left as-is on purpose rather than overlooked. All of them
assume the threat model this app is actually built for: a single operator, a trusted local
network, never the open internet. If that stops being true for your deployment, revisit
this list before you rely on any of it.

- **Catalog/images host paths can be pointed at any directory on the machine.**
  `POST /api/settings/host-paths` writes `CATALOG_HOST_PATH`/`IMAGES_HOST_PATH` to `.env`
  with no restriction on the value — by design, since pointing this at any local project's
  data is the feature's actual purpose, not an edge case to close off. That value becomes
  the Docker bind-mount source on the next container recreate, and `GET /images/:filename`
  then serves whatever's in it. Reachable by anything that can reach `/api/*`. Don't widen
  `BIND_ADDRESS` beyond a network you'd trust with that.
- **Snapshot restore extracts a `.tar.gz` with no check on its contents**
  (`POST /:filename/restore`), which can overwrite application source or `.env`. There is no
  upload route for backups — the only way an untrusted archive reaches `data/backups/` is if
  you put it there yourself. Only restore snapshots from a source you trust, the same as
  you'd treat any other executable content.
- **Schema import (`POST /exports/schema-from-url`) feeds a fetched web page to the model
  unfenced.** A page designed to do so could influence what comes back. This only ever runs
  against a URL you supply — treat it like importing code from a URL, not like browsing.
- **Export zips can carry `../` in their internal paths** if `imageExportBase` (an
  operator-typed field on an export map) contains one. Only harms whoever extracts the zip —
  don't put `../` in that field, and be careful handing an export to someone else if you did.
- **The outbound-fetch SSRF guard doesn't cover every special-use IP range** (a handful of
  obscure ones — TEST-NET, benchmarking, multicast) and re-resolves the hostname separately
  at connect time, leaving a narrow DNS-rebinding window. The ranges that matter in practice
  — loopback, private, link-local, the cloud metadata address — are all covered.

## Supported versions

This is a prototype under active development on a single branch (`main`) — there is no
version-support matrix. Security fixes land on `main`; there are no backported patches to
older tags.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Report it privately through
[GitHub's security advisories](../../security/advisories/new) for this repository. Include
what you found, the affected route or file, and steps to reproduce if you have them.

You should get an initial response within a few business days.
