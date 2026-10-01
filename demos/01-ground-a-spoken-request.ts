/**
 * Demo 1: grounding a spoken request against a real catalog.
 *
 * Speech recognition mishears project names, and a voice assistant that
 * guesses will act on the wrong repository. Circe resolves the project slot
 * against the bounded list of projects your machines actually have, and asks
 * instead of guessing when the name is unclear.
 *
 * Run: node demos/01-ground-a-spoken-request.ts
 */
import { groundVoiceTurn } from "../packages/circe-core/src/groundVoiceTurn.ts";

interface Project {
  readonly title: string;
  readonly machine: string;
}

const projects: ReadonlyArray<Project> = [
  { title: "Rivvl", machine: "desktop" },
  { title: "Alertify", machine: "desktop" },
  { title: "Portfolio", machine: "laptop" },
  { title: "Portfolio", machine: "build-box" },
];

const candidates = projects.map((project) => ({
  id: `${project.machine}:${project.title}`,
  title: project.title,
  label: `${project.title} on ${project.machine}`,
  names: [project.title],
  project,
}));

const utterances = [
  // Heard correctly.
  "start a task in Rivvl to fix the login bug",
  // A close mishearing inside a clear project slot.
  "start a task in rival to fix the login bug",
  // A distant mishearing: Circe will not act on it without a yes.
  "I need you to check out Zivil.",
  // Two machines own a project with this name.
  "Open Portfolio.",
  // No project named at all.
  "what is running right now",
];

for (const utterance of utterances) {
  const turn = groundVoiceTurn({ utterance, candidates });
  console.log(`\nYou say:  "${utterance}"`);
  switch (turn.status) {
    case "resolved":
      console.log(`Circe:    routes to ${turn.project.title} on ${turn.project.machine}`);
      console.log(`          heard "${turn.heard}" (${turn.match} match)`);
      console.log(`          sends: "${turn.utterance}"`);
      break;
    case "needs-confirmation":
      console.log(`Circe:    asks "${turn.prompt}"`);
      console.log(`          heard "${turn.heard}", will not act until you confirm`);
      break;
    case "needs-clarification":
      console.log(`Circe:    asks "${turn.prompt}"`);
      for (const candidate of turn.candidates) {
        console.log(`          option: ${candidate.label}`);
      }
      break;
    case "not-mentioned":
      console.log("Circe:    no project named, so nothing is routed by project");
      break;
  }
}
