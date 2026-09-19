# Circe

> [!IMPORTANT]
> **Circe is paused.** I parked this project on 2026-09-20. The code stays
> public and the work is real, but I am not shipping, supporting, or accepting
> feature work on it right now.

## What I was trying to build

One assistant for all of my machines. Not a chat app, and not a coding tool
with a voice layer — an operator. I say what I want, and it happens on the
machine where it needs to happen, with my real accounts and my own provider
subscriptions doing the thinking.

The destination was a personal mesh of machines I own. "Get my resume from
laptop A, put it in the portfolio on laptop B" should be one sentence, executed
as a typed, auditable plan where every step names its node, every artifact is
owned by a node, and a disconnected machine is reported rather than silently
swapped for another. Voice is the interface, not the product.

What is in this repo today:

- The T3 coding foundation: orchestration, provider adapters (Codex, Claude,
  Cursor, Grok, OpenCode, Antigravity), Git, terminals, approvals, and
  event-sourced state.
- Circe: deterministic voice control, grounded task routing against real
  catalogs, multi-node discovery and remote control, and spoken reports.
- Grounded surface missions: a closed, TypeSafe step loop that drives the real
  desktop and the user's own browser on Linux, including GNOME Wayland
  (AT-SPI element grounding, ydotool/uinput input, portal capture). The model
  never invents a target, a coordinate, or typed text; typed text is selected
  from bounded spans of the user's own words.

What is not built: cross-node artifacts and mesh plans (the workflow engine
this vision needs), window-scoped browser grounding, and the daily reliability
work that would make the operator trustworthy enough to charge for.

## What Circe was

Circe is a control plane for coding agents. Direct provider CLIs from one calm
interface across your machines: desktop workspace and local execution, remote
control from phone or browser, deterministic voice control, task navigation,
and spoken reports.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build,
OpenCode, and Google Antigravity. If they're set up on your computer, Circe can
control them.

## Installation

> [!WARNING]
> Circe currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and
> Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Try it out (install-free)

The easiest way to test Circe is to run the server in your terminal (requires
Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx @absterrg0/circe@latest
```

This launches Circe on your machine as well as the local web app to control
your agents.

Tip: Use `npx @absterrg0/circe@latest --help` for the full CLI reference.
Follow [Circe installation instructions](./docs/user/install.md) for the desktop
and mobile apps.

### Desktop app

Install the latest version of the desktop app from
[GitHub Releases](https://github.com/Absterrg0/Circe/releases), or from your
favorite package registry:

#### Arch Linux (AUR)

Stable:

```bash
yay -S circe-bin
```

Nightly:

```bash
yay -S circe-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Design

Circe follows the [Circe design system](./docs/internals/circe-design-system.md):
quiet by default, warm paper and copper materials, editorial serif for identity,
signal over spectacle.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- [Circe](./docs/user/circe.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run Circe as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

Circe uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/Absterrg0/Circe/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
