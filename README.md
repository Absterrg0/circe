<p align="center">
  <img src="./assets/circe/circe-web-apple-touch-180.png" width="88" height="88" alt="Circe" />
</p>

# Circe

One assistant for all of your machines. You say what you want, and it happens on the machine where
it needs to happen, with your own accounts and your own coding-agent subscriptions doing the work.

> [!IMPORTANT]
> **Circe is not a finished product.** It is a working prototype I am building in the open. Some
> parts hold up well, some are rough, and some are not built yet. This repository is here to show
> the idea and the work, not to sell you a tool. The [demos](#demos) are the fastest way to see
> what it does. The [status](#what-works-and-what-does-not) section says where it stands.

Website: [heycirce.com](https://heycirce.com)

## What it is

Circe is a control plane for coding agents with voice as the interface. It is built on
[T3 Code](https://github.com/pingdotgg/t3code), the open-source coding-agent harness. T3 provides
the orchestration engine, provider adapters, Git, terminals, approvals, and the detailed coding
UI. Circe adds three things on top:

- **Voice you can trust.** A spoken request is matched against the real projects, tasks, and
  machines you have. When a name is unclear, Circe asks. A model never invents an id, picks
  between two matches, or dispatches a command on its own.
- **Many machines, one assistant.** Each machine owns its projects, credentials, and history.
  Work runs on the machine that owns the project, or the one you name. A disconnected machine is
  reported, never silently swapped for another.
- **Desktop and browser use.** Circe can open apps, click, type, and scroll in your own signed-in
  apps. It asks before it touches anything, types only words you said, and reports done only when
  the screen shows the result.

It works with Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they are
set up on your computer, Circe can direct them.

## Demos

Three demos run from a clone with no microphone, no account, and no server. They call the same
code the app uses to decide what a request means.

```sh
vp i
node demos/01-ground-a-spoken-request.ts
node demos/02-typed-text-comes-from-your-words.ts
node demos/03-spoken-report.ts
```

**A misheard project name does not send work to the wrong repository.**

```text
You say:  "start a task in rival to fix the login bug"
Circe:    routes to Rivvl on desktop
          heard "rival" (near match)
          sends: "start a task in Rivvl to fix the login bug"

You say:  "I need you to check out Zivil."
Circe:    asks "Did you mean Rivvl?"
          heard "Zivil", will not act until you confirm

You say:  "Open Portfolio."
Circe:    asks "More than one project matches “Portfolio”. Which one did you mean?"
          option: Portfolio on laptop
          option: Portfolio on build-box
```

**Circe can only type words you said.** On a real desktop the model picks from a closed list of
spans cut from your instruction, so a web page with hidden instructions cannot make it type
something else.

```text
Goal:      search for weather in Ahmedabad on the browser
May type:  "weather", "search for weather in Ahmedabad on the browser", ...
           (31 candidates, every one a span of the goal)
Done when: the screen shows the result the goal names
```

**A written report becomes something worth hearing.** The full report stays in the task. Speech
gets whole sentences inside a budget, with code replaced by one plain line.

The full output, the source for each demo, and a list of things to try in the app are in
[demos/](./demos/README.md).

## What works and what does not

| Area                                                                          | State                                                                                                                                   |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Coding-agent foundation (orchestration, providers, Git, terminals, approvals) | Solid. Inherited from T3 Code.                                                                                                          |
| Grounded voice routing against real project and task catalogs                 | Works. Covered by the demos and their tests.                                                                                            |
| Multi-machine discovery, pairing, and remote control                          | Works.                                                                                                                                  |
| Live spoken conversation                                                      | Works, with rough edges. Needs a Circe Mesh link or your own OpenAI API key.                                                            |
| Desktop and browser use                                                       | Works for simple goals. Linux, including GNOME Wayland, is where it has been exercised most. Longer goals fail too often for a product. |
| Phone app                                                                     | In the repo as a React Native client. Build it from source.                                                                             |
| Cross-machine plans ("get the file from laptop A, use it on laptop B")        | Not built. This is the workflow engine the idea needs.                                                                                  |
| The daily reliability that would make it trustworthy enough to charge for     | Not there yet.                                                                                                                          |

## Try it

You need at least one coding agent installed and signed in:

- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
- Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
- Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**

Then run the server in a terminal (Node.js 22.16+, 23.11+, or 24.10+):

```sh
npx @absterrg0/circe@latest
```

This starts Circe on your machine and opens the local web app. `--help` lists the CLI options.

Desktop builds are on [GitHub Releases](https://github.com/Absterrg0/circe/releases). Voice, the
orb, the hotkey, and desktop use live in the desktop app, so that is the one to try. Full steps are
in [docs/user/install.md](./docs/user/install.md).

Expect bugs. The published builds can lag behind this branch.

## Documentation

- [Circe: voice, machines, and routing](./docs/user/circe.md)
- [Desktop use](./docs/user/desktop-use.md)
- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Run Circe as a background service](./docs/user/background-service.md)
- [Design system](./docs/internals/circe-design-system.md)

All of the docs are in [docs/](./docs). To read the architecture, start at
[docs/internals/overview.md](./docs/internals/overview.md).

## Build from source

Circe uses [Vite+](https://viteplus.dev/guide/), so install the `vp` tool first.

```sh
curl -fsSL https://vite.plus | bash   # macOS and Linux
irm https://vite.plus/ps1 | iex       # Windows
```

```sh
vp i
vp run dev
```

`vp run dev` starts the server and the web app with state local to the checkout. The ports and the
pairing link are printed by the dev runner.

## Contributing

I am not taking feature contributions while the core is still moving. Small fixes are welcome.
Read [CONTRIBUTING.md](./CONTRIBUTING.md) first.

## Credit and license

Circe is a fork of [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools, and most of the
coding foundation is their work. MIT licensed. See [LICENSE](./LICENSE).
