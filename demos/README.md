# Demos

Circe is unfinished. These demos show the parts that work and the ideas behind them. The first
three run from a clone with no microphone, no provider account, and no server: they call the same
code the app uses to decide what a spoken request means.

```sh
vp i
node demos/01-ground-a-spoken-request.ts
node demos/02-typed-text-comes-from-your-words.ts
node demos/03-spoken-report.ts
```

You need Node 24 or newer. The output below is copied from real runs.

## 1. A misheard project name does not send work to the wrong repository

Speech recognition gets project names wrong, and an assistant that guesses will act on the wrong
code. Circe matches the project you named against the projects your machines actually have. A
close mishearing in a clear spot is corrected. A distant one gets a question. Two machines with
the same project name get a question that names both.

```text
You say:  "start a task in Rivvl to fix the login bug"
Circe:    routes to Rivvl on desktop
          heard "Rivvl" (exact match)
          sends: "start a task in Rivvl to fix the login bug"

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

You say:  "what is running right now"
Circe:    no project named, so nothing is routed by project
```

Source: [`01-ground-a-spoken-request.ts`](./01-ground-a-spoken-request.ts), which calls
[`groundVoiceTurn`](../packages/circe-core/src/groundVoiceTurn.ts).

## 2. Circe can only type words you said

When Circe drives a real desktop, the model never writes free text into your apps. It chooses from
a closed list of spans cut from your own instruction. A web page with hidden instructions cannot
make it type a sentence you never said, because that sentence is not on the list.

The goal also fixes what "done" means before anything is clicked. A click that changed nothing is
not reported as success.

```text
Goal:      open the calculator and type "12 * 7"
May type:  "12 * 7", "\"12 * 7\"", "open the calculator and type \"12 * 7\"", "open the calculator and type"
           (31 candidates, every one a span of the goal)
           all taken from your words: true
Done when: the screen shows the result the goal names

Goal:      search for weather in Ahmedabad on the browser
May type:  "weather", "search for weather in Ahmedabad on the browser", "search for weather in Ahmedabad", "search for weather in"
           (31 candidates, every one a span of the goal)
           all taken from your words: true
Done when: the screen shows the result the goal names

Goal:      click the Save button
May type:  "click the Save button", "click the Save", "click the", "click"
           (10 candidates, every one a span of the goal)
           all taken from your words: true
Done when: "the Save button" was activated once

Goal:      save the notes as groceries.txt
May type:  "save the notes as groceries.txt", "save the notes as", "save the notes", "save the"
           (15 candidates, every one a span of the goal)
           all taken from your words: true
Done when: there is evidence the file or content was saved
```

Source: [`02-typed-text-comes-from-your-words.ts`](./02-typed-text-comes-from-your-words.ts),
which calls [`buildTypeTextCandidates` and `inferComputerExpectation`](../packages/circe-core/src/computerUse.ts).

## 3. A written report becomes something worth hearing

A coding agent finishes with Markdown, code fences, and file paths. Reading that aloud is useless.
Circe keeps the full report in the task and speaks a bounded summary: whole sentences first, code
replaced by one plain line.

````text
The agent wrote:

## Fixed the login redirect

The callback handler dropped the `next` parameter when the session cookie was already set.
I now carry it through the redirect and added a test for the signed-in case.

```ts
const next = url.searchParams.get("next") ?? "/";
return redirect(sanitizeNext(next));
````

**Checks:** 14 tests pass, typecheck clean. The change is on branch `fix/login-redirect` and
is ready for review. I did not touch the OAuth provider configuration, and the staging
environment still needs the new cookie domain before this can be verified end to end.

Circe says, with a 320-character budget:

Fixed the login redirect The callback handler dropped the next parameter when the session cookie was already set. I now carry it through the redirect and added a test for the signed-in case. The code details are waiting in your workspace. Checks: 14 tests pass, typecheck clean.…

Circe says, with a 200-character budget:

Fixed the login redirect The callback handler dropped the next parameter when the session cookie was already set. I now carry it through the redirect and added a test for the signed-in case.…

````

Source: [`03-spoken-report.ts`](./03-spoken-report.ts), which calls
[`selectSpokenSummary`](../packages/circe-core/src/spokenSummary.ts).

## Things to try in the app

These need the desktop app and at least one signed-in coding agent (Claude Code, Codex, Cursor,
Grok Build, or OpenCode). Install steps are in [docs/user/install.md](../docs/user/install.md).
Expect rough edges: this is the part of Circe still being built.

| Say or type | What happens |
| --- | --- |
| "What's running?" | Circe reads live task state across your paired machines. |
| "Start a task to check auth in Rivvl on my laptop" | The task starts on the machine you named. If that machine does not have the project, Circe tells you where it is. |
| "On Desktop, fix the login bug" | Same routing, device first. A device name is a hard constraint, never a hint. |
| "Open the calculator and add 12 and 30" | Circe repeats the goal and asks before it touches anything. It reports done only when the screen shows the result. |
| "Open YouTube and search for lo-fi" | Desktop use in your own signed-in browser, after the same yes. |
| "Stop" | Stops the current desktop run. A step that may or may not have landed is reported as uncertain. |

More detail: [Circe](../docs/user/circe.md), [desktop use](../docs/user/desktop-use.md), and
[remote access](../docs/user/remote-access.md).

## Want to see the proof instead of the pitch

Each demo has tests beside the code it calls. Run the ones for a single file:

```sh
cd packages/circe-core
vp test run src/groundVoiceTurn.test.ts src/computerUse.test.ts src/spokenSummary.test.ts
````
