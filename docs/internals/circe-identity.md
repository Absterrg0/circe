# Circe identity

Circe is the product name and the only name used across visible copy, code, packages, installed identities, and stored data. The earlier split (visible ARIS with reserved Jarvis identifiers) is gone; there is no reserved codename.

## What is Circe

- Display name `Circe`; nightly desktop builds show `Circe (Nightly)`; mobile variants show `Circe Dev`, `Circe Preview`, `Circe`.
- App and bundle IDs: `com.abstergo.circe`, `com.abstergo.circe.dev`, `com.abstergo.circe.preview`.
- Desktop schemes `circe` and `t3-dev`, plus the upstream mobile schemes `t3code`, `t3code-dev`, `t3code-preview`.
- Packages `@circe/core`, `@circe/client-runtime`, `@circe/relay`, in `packages/circe-*`.
- CLI package `@absterrg0/circe` (built from `apps/server`) with the `circe` command and its subcommands (`circe connect`, `circe serve`, `circe service`).
- Data: `~/.circe`, `~/.circe-headless`, `.circe` config paths, `CIRCE_*` environment variables, `circe-resources`, `circe-official-release.json`, `official-circe` and `unified-circe`.
- Release endpoints `https://github.com/Absterrg0/Circe/releases` with artifacts `Circe-${version}-${arch}.${ext}`.
- Migrations keep numeric IDs 41 through 58 and their `Circe*` names.
- Relay resources, Clerk audience, and OTLP variables are Circe-named (`circe-relay`, `CIRCE_RELAY_URL`).

## Legacy T3 names are removed

There is no upstream and no users, so the rename is a hard cut rather than a
phased one. The inherited `t3code:*` storage keys, `t3code` URL schemes, the
`t3code` service and desktop-entry names, the `com.t3tools.T3Code` D-Bus
names, the `t3-code` MCP server name, and the `t3-*` native module identities
are gone. Nothing is aliased and no stored state is migrated; a fresh install
starts clean. User-visible copy says Circe everywhere.

Two inherited values stay because they belong to other systems, not to Circe:

- The GNOME extension UUID `snap-shot@t3.codes`. GNOME only discovers a newly
  installed extension under the UUID it was installed with.
- The xAI OAuth referrer `t3code` passed to the `grok` CLI, which is part of
  that provider's sign-in handshake.

## Example catalog names

The semantic fixtures use `Beacon` as the example project alongside `Rivvl`. The assistant name is reserved, so an example project must not be named `Circe`: a project named the same as the assistant fuzzy-matches the assistant name during grounding.
