/**
 * Demo 2: what Circe is allowed to type, and when a desktop goal counts as done.
 *
 * When Circe drives a real desktop, the model never writes free text into your
 * apps. It picks from a closed list of spans cut out of your own instruction.
 * A prompt-injected web page or a hallucinating model cannot make it type a
 * sentence you never said, because that sentence is not on the list.
 *
 * The goal also fixes what "done" means before anything is clicked, so a
 * click that changed nothing cannot be reported as success.
 *
 * Run: node demos/02-typed-text-comes-from-your-words.ts
 */
import {
  buildTypeTextCandidates,
  inferComputerExpectation,
} from "../packages/circe-core/src/computerUse.ts";

const goals = [
  'open the calculator and type "12 * 7"',
  "search for weather in Ahmedabad on the browser",
  "click the Save button",
  "save the notes as groceries.txt",
];

for (const goal of goals) {
  const candidates = buildTypeTextCandidates(goal);
  const expectation = inferComputerExpectation(goal);
  console.log(`\nGoal:      ${goal}`);
  console.log(
    `May type:  ${candidates
      .slice(0, 4)
      .map((text) => JSON.stringify(text))
      .join(", ")}`,
  );
  console.log(`           (${candidates.length} candidates, every one a span of the goal)`);
  const everyCandidateIsYours = candidates.every((text) => goal.includes(text));
  console.log(`           all taken from your words: ${everyCandidateIsYours}`);
  switch (expectation.kind) {
    case "action":
      console.log(`Done when: "${expectation.target}" was activated once`);
      break;
    case "state":
      console.log("Done when: the screen shows the result the goal names");
      break;
    case "artifact":
      console.log("Done when: there is evidence the file or content was saved");
      break;
  }
}
