# Circe rename: external changes

The repository no longer ships the inherited T3 names. Code, packages, the CLI,
installers, and the environment discovery path are Circe now. This runbook lists
the changes that live outside the repository, so a maintainer can finish the
rename on real infrastructure.

## Already changed in the repository

- Workspace packages are `@circe/*`; the generic client seam is `@circe/client`.
- The published server is `@absterrg0/circe` with the `circe` bin.
- Launcher package `@absterrg0/circe`; platform packages `@absterrg0/circe-<platform>`.
- Installed executables and shims: `circe`, `circe.exe`, `circe.cmd`, `bin/circe.js`.
- Release archive stem `circe-<version>-<platform>-<arch>`.
- Releases are fetched from `github.com/Absterrg0/circe`.
- Environment discovery endpoint `/.well-known/circe/environment`.
- Data directory `~/.circe`, overridden by `CIRCE_HOME`.
- Environment variables `T3CODE_*` are now `CIRCE_*`.
- Installer interface: `CIRCE_HOME`, `CIRCE_CHANNEL`, `CIRCE_VERSION`,
  `CIRCE_INSTALL_BIN_DIR`, `CIRCE_RELEASE_BASE_URL`.

`~/.t3` and `~/.jarvis` belong to other products. Circe never reads or writes
them, and the rename does not migrate them.

## External changes still required

### 1. CI and environment secrets

Every secret or variable named `T3CODE_*` must be recreated as `CIRCE_*` in the
GitHub repository and any other CI provider, then the old name removed. The code
reads the new names.

Secret or configured values observed in workflows and scripts:

- Source control: `CIRCE_BITBUCKET_EMAIL`, `CIRCE_BITBUCKET_API_TOKEN`,
  `CIRCE_BITBUCKET_ACCESS_TOKEN`, `CIRCE_BITBUCKET_API_BASE_URL`.
- Apple signing: `CIRCE_APPLE_TEAM_ID`, `CIRCE_MACOS_PROVISIONING_PROFILE`,
  `CIRCE_IOS_PERSONAL_TEAM`, `CIRCE_IOS_PERSONAL_TEAM_BUNDLE_ID`,
  `CIRCE_CLI_MAC_SIGN_IDENTITY`.
- Telemetry: `CIRCE_POSTHOG_KEY`, `CIRCE_POSTHOG_HOST`, `CIRCE_OTLP_*`,
  `CIRCE_TELEMETRY_*`, `CIRCE_TRACE_*`, `CIRCE_LOG_*`.
- Release and domains: `CIRCE_RELEASE_BASE_URL`, `CIRCE_WEB_NIGHTLY_DOMAIN`,
  `CIRCE_WEB_LATEST_DOMAIN`, `CIRCE_DESKTOP_UPDATE_REPOSITORY`.
- Build and tooling: `CIRCE_BUILD_RELAY_URL__`, `CIRCE_BUILD_RELAY_CLIENT_OTLP_TRACES_*`,
  `CIRCE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__`, `CIRCE_BUILD_CHANNEL__`,
  `CIRCE_PACK_EXE`, `CIRCE_PACK_EXE_TARGET`, `CIRCE_SECRET`, `CIRCE_COMMIT_HASH`.
- Runtime configuration: `CIRCE_PORT`, `CIRCE_HOST`, `CIRCE_MODE`, `CIRCE_DEV_*`,
  `CIRCE_DESKTOP_*`, `CIRCE_MOBILE_*`, `CIRCE_TAILSCALE_*`, `CIRCE_CLOUDFLARED_PATH`,
  `CIRCE_CURSOR_ENABLED`, `CIRCE_DISABLE_AUTO_UPDATE`, `CIRCE_LICENSES_STRICT`.

Short-lived test and replay variables still use the `T3_` prefix
(`T3_ACP_*`, `T3_FAKE_*`, `T3_CODEX_REPLAY_*`, and similar). They are fixture
inputs, not deployment secrets, and are safe to rename in a later sweep.

### 2. Domains

- `https://app.t3.codes` is `https://app.heycirce.com/`.
- Install headers and the project-file schema URL still reference `t3.codes`
  (108 occurrences). Point them at the Circe domain once it serves install
  scripts and the schema.
- The `T3_PROJECT_FILE_SCHEMA_URL` value and any CDN cache for the schema must
  move together.

### 3. npm

- Publish `@absterrg0/circe-<platform>` platform packages and the
  `@absterrg0/circe` launcher under the new archive layout.
- The legacy `@t3code/t3-<platform>` packages and the old `npx t3` path are no
  longer produced. Deprecate them on npm with a message pointing at
  `npx @absterrg0/circe`.

### 4. Background service

- The systemd unit is `circe.service`. Existing installs with `t3code.service`
  need `circe service install` to replace it; uninstall the old unit.
- `T3_BOOT_SERVICE_UNIT` and `T3_SERVICE_LAUNCHER_CONTEXT` are read from the
  installed launcher environment and must be set to their `CIRCE_` equivalents.

### 5. Native helper and packaging

- The Rust crate `t3-resource-monitor` (34 references) needs a coordinated
  rename to `circe-resource-monitor` across Cargo manifests, the signing
  filter, desktop packaging, and `CIRCE_RESOURCE_MONITOR_PATH`.
- Desktop application id, bundle name, and macOS permission helper copy must all
  say Circe, including the packaged app path used by the permission wizard.

### 6. Company and legal names

- `T3 Tools, Inc.` and third-party licence text are legal identifiers. Rename
  only with legal review; the code rename does not touch them.
