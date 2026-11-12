import {
  CommandId,
  EventId,
  ProjectId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@circe/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const chatRoot = "/home/user/.circe/conversations";

/** A workspace recorded the way nodes recorded their chat space before it was typed. */
const untypedCreated = (
  projectId: ProjectId,
  title: string,
  workspaceRoot: string,
  sequence: number,
): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`evt-chat-space-${sequence}`),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make(`cmd-chat-space-seed-${sequence}`),
  causationEventId: null,
  correlationId: CommandId.make(`cmd-chat-space-seed-${sequence}`),
  metadata: {},
  payload: {
    projectId,
    title,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
});

/** Decide a command and fold its event into the read model, as the engine does. */
const apply = Effect.fn("chatSpaceTest.apply")(function* (
  readModel: OrchestrationReadModel,
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
) {
  const decided = yield* decideOrchestrationCommand({ command, readModel });
  const events = Array.isArray(decided) ? decided : [decided];
  let next = readModel;
  for (const event of events) {
    next = yield* projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 });
  }
  return next;
});

const legacyId = ProjectId.make("project-legacy-conversations");

it.layer(NodeServices.layer)("decider chat space", (it) => {
  it.effect("creates the chat space typed and titled, never as a project", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-chat-space");
      const readModel = yield* apply(createEmptyReadModel(now), {
        type: "project.chat-space.create",
        commandId: CommandId.make("cmd-chat-space-create"),
        projectId,
        workspaceRoot: chatRoot,
        createdAt: now,
      });
      expect(readModel.projects).toMatchObject([
        { id: projectId, kind: "chats", title: "Chats", workspaceRoot: chatRoot },
      ]);
    }),
  );

  it.effect("records a workspace without a kind as a project", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(
        createEmptyReadModel(now),
        untypedCreated(legacyId, "Conversations", chatRoot, 1),
      );
      expect(readModel.projects[0]?.kind).toBe("project");
    }),
  );

  it.effect("adopts the old Conversations project as the chat space and renames it", () =>
    Effect.gen(function* () {
      const seeded = yield* projectEvent(
        createEmptyReadModel(now),
        untypedCreated(legacyId, "Conversations", chatRoot, 1),
      );
      const readModel = yield* apply(seeded, {
        type: "project.chat-space.adopt",
        commandId: CommandId.make("cmd-chat-space-adopt"),
        projectId: legacyId,
        workspaceRoot: chatRoot,
      });
      expect(readModel.projects).toMatchObject([
        { id: legacyId, kind: "chats", title: "Chats", workspaceRoot: chatRoot },
      ]);
    }),
  );

  it.effect("moves the chat space when the node's directory moved", () =>
    Effect.gen(function* () {
      const seeded = yield* projectEvent(
        createEmptyReadModel(now),
        untypedCreated(legacyId, "Conversations", "/old/home/.circe/conversations", 1),
      );
      const readModel = yield* apply(seeded, {
        type: "project.chat-space.adopt",
        commandId: CommandId.make("cmd-chat-space-move"),
        projectId: legacyId,
        workspaceRoot: chatRoot,
      });
      expect(readModel.projects[0]).toMatchObject({ kind: "chats", workspaceRoot: chatRoot });
    }),
  );

  it.effect("refuses a second chat space", () =>
    Effect.gen(function* () {
      const first = yield* apply(createEmptyReadModel(now), {
        type: "project.chat-space.create",
        commandId: CommandId.make("cmd-chat-space-first"),
        projectId: ProjectId.make("project-chat-space-first"),
        workspaceRoot: chatRoot,
        createdAt: now,
      });
      const created = yield* decideOrchestrationCommand({
        readModel: first,
        command: {
          type: "project.chat-space.create",
          commandId: CommandId.make("cmd-chat-space-second"),
          projectId: ProjectId.make("project-chat-space-second"),
          workspaceRoot: "/elsewhere/conversations",
          createdAt: now,
        },
      }).pipe(Effect.flip);
      expect(created._tag).toBe("OrchestrationCommandInvariantError");

      const withOther = yield* projectEvent(
        first,
        untypedCreated(legacyId, "Conversations", "/elsewhere/conversations", 2),
      );
      const adopted = yield* decideOrchestrationCommand({
        readModel: withOther,
        command: {
          type: "project.chat-space.adopt",
          commandId: CommandId.make("cmd-chat-space-adopt-second"),
          projectId: legacyId,
          workspaceRoot: "/elsewhere/conversations",
        },
      }).pipe(Effect.flip);
      expect(adopted._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("refuses to rename, move, or delete the chat space from any dispatch path", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-chat-space-guard");
      const readModel = yield* apply(createEmptyReadModel(now), {
        type: "project.chat-space.create",
        commandId: CommandId.make("cmd-chat-space-guard"),
        projectId,
        workspaceRoot: chatRoot,
        createdAt: now,
      });
      const reject = (command: Parameters<typeof decideOrchestrationCommand>[0]["command"]) =>
        decideOrchestrationCommand({ readModel, command }).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        );
      expect(
        yield* reject({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-chat-space-rename"),
          projectId,
          title: "Mine now",
        }),
      ).toBe("OrchestrationCommandInvariantError");
      expect(
        yield* reject({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-chat-space-relocate"),
          projectId,
          workspaceRoot: "/elsewhere",
        }),
      ).toBe("OrchestrationCommandInvariantError");
      expect(
        yield* reject({
          type: "project.delete",
          commandId: CommandId.make("cmd-chat-space-delete"),
          projectId,
          force: true,
        }),
      ).toBe("OrchestrationCommandInvariantError");

      // Choosing the model that answers chats is still a plain metadata update.
      const updated = yield* apply(readModel, {
        type: "project.meta.update",
        commandId: CommandId.make("cmd-chat-space-autopull"),
        projectId,
        autoPull: false,
      });
      expect(updated.projects[0]).toMatchObject({ kind: "chats", title: "Chats" });
    }),
  );
});
