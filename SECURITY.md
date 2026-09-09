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

## Supported versions

This is a prototype under active development on a single branch (`main`) — there is no
version-support matrix. Security fixes land on `main`; there are no backported patches to
older tags.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Report it privately through
[GitHub's security advisories](../../security/advisories/new) for this repository. Include
what you found, the affected route or file, and steps to reproduce if you have them.

You should get an initial response within a few business days.
