import { CommandId, EventId, ProjectId, type ProjectScript } from "@circe/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
it.layer(NodeServices.layer)("decider project scripts", (it) => {
  it.effect("emits empty scripts on project.create", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const readModel = createEmptyReadModel(now);

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-scripts"),
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.created");
      expect((event.payload as { scripts: unknown[] }).scripts).toEqual([]);
    }),
  );

  it.effect("propagates scripts in project.meta.update payload", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const readModel = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-scripts"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-scripts"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-scripts"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-scripts"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const scripts = [
        {
          id: "lint",
          name: "Lint",
          command: "bun run lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ] as const;

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-scripts"),
          projectId: asProjectId("project-scripts"),
          scripts: Array.from(scripts),
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect((event.payload as { scripts?: unknown[] }).scripts).toEqual(scripts);
    }),
  );

  const script = (id: string): ProjectScript => ({
    id,
    name: "Install dependencies",
    command: "vp i",
    icon: "configure",
    runOnWorktreeCreate: false,
  });

  const projectWithScripts = (scripts: ReadonlyArray<ProjectScript>) => {
    const now = "2026-01-01T00:00:00.000Z";
    return projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: asEventId("evt-legacy-scripts"),
      aggregateKind: "project",
      aggregateId: asProjectId("project-scripts"),
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-legacy-scripts"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-legacy-scripts"),
      metadata: {},
      payload: {
        projectId: asProjectId("project-scripts"),
        title: "Scripts",
        workspaceRoot: "/tmp/scripts",
        defaultModelSelection: null,
        scripts,
        createdAt: now,
        updatedAt: now,
      },
    });
  };

  for (const id of ["install-javascript-dependencies", "A", "a.b", "a b", "-a", "a".repeat(25)]) {
    it.effect(`rejects a new script ID that cannot have a shortcut: ${id}`, () =>
      Effect.gen(function* () {
        const readModel = yield* projectWithScripts([]);
        const failure = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            command: {
              type: "project.meta.update",
              commandId: CommandId.make("cmd-invalid-script"),
              projectId: asProjectId("project-scripts"),
              scripts: [script("lint"), script(id)],
            },
          }),
        );
        expect(failure).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
        expect(failure.message).toContain("Script ID");
        expect(failure.message).toContain("24");
        expect(readModel.projects[0]?.scripts).toEqual([]);
      }),
    );
  }

  it.effect("accepts a script ID at the shortcut length limit", () =>
    Effect.gen(function* () {
      const readModel = yield* projectWithScripts([]);
      const scripts = [script("a".repeat(24))];
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-valid-script"),
          projectId: asProjectId("project-scripts"),
          scripts,
        },
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.payload).toMatchObject({ scripts });
    }),
  );

  it.effect(
    "keeps legacy scripts readable, editable and removable while allowing valid additions",
    () =>
      Effect.gen(function* () {
        const legacy = script("install-javascript-dependencies");
        const readModel = yield* projectWithScripts([legacy]);
        expect(readModel.projects[0]?.scripts).toEqual([legacy]);
        for (const scripts of [[{ ...legacy, command: "vp install" }, script("lint")], []]) {
          const result = yield* decideOrchestrationCommand({
            readModel,
            command: {
              type: "project.meta.update",
              commandId: CommandId.make("cmd-repair-script"),
              projectId: asProjectId("project-scripts"),
              scripts,
            },
          });
          const event = Array.isArray(result) ? result[0] : result;
          expect(event.payload).toMatchObject({ scripts });
        }
        const failure = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            command: {
              type: "project.meta.update",
              commandId: CommandId.make("cmd-new-invalid-script"),
              projectId: asProjectId("project-scripts"),
              scripts: [legacy, script("another.invalid.id")],
            },
          }),
        );
        expect(failure).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      }),
  );

  it.effect("propagates project icon metadata in project.meta.update", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const readModel = yield* projectEvent(createEmptyReadModel(now), {
        sequence: 1,
        eventId: asEventId("evt-project-create-favicon"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-favicon"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-favicon"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-favicon"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-favicon"),
          title: "Favicon",
          workspaceRoot: "/tmp/favicon",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-favicon"),
          projectId: asProjectId("project-favicon"),
          faviconPath: "brand/icon.svg",
          projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect((event.payload as { faviconPath?: string }).faviconPath).toBe("brand/icon.svg");
      expect((event.payload as { projectIcon?: unknown }).projectIcon).toEqual({
        kind: "lucide",
        name: "alarm-clock",
        color: "violet",
      });

      for (const text of ["T3", "e\u0301", "किखि", "क्ष्म", "\u1100\u1161\u11a8"]) {
        const monogram = { kind: "monogram", text, color: "violet" } as const;
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-monogram"),
            projectId: asProjectId("project-favicon"),
            projectIcon: monogram,
          },
          readModel,
        });
        const updated = Array.isArray(result) ? result[0] : result;
        expect(updated.payload).toMatchObject({ projectIcon: monogram });
      }
      for (const text of ["ABC", "किखिगि"]) {
        const failure = yield* Effect.flip(
          decideOrchestrationCommand({
            command: {
              type: "project.meta.update",
              commandId: CommandId.make("cmd-monogram-invalid"),
              projectId: asProjectId("project-favicon"),
              projectIcon: { kind: "monogram", text, color: "violet" },
            },
            readModel,
          }),
        );
        expect(failure).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      }
    }),
  );

  it.effect("rejects project.create for an active workspace root that already exists", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const readModel = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-existing"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-existing"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("cmd-project-create-duplicate-root"),
            projectId: asProjectId("project-duplicate-root"),
            title: "Duplicate Project",
            workspaceRoot: "/tmp/project/",
            createdAt: now,
          },
          readModel,
        }),
      );

      expect(failure.message).toContain(
        "Active project 'project-existing' already exists for workspace root '/tmp/project'.",
      );
    }),
  );

  it.effect("rejects project.meta.update when moving onto another active workspace root", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const initial = createEmptyReadModel(now);
      const withFirstProject = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-first"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-first"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-first"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-first"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-first"),
          title: "First",
          workspaceRoot: "/tmp/project-first",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const readModel = yield* projectEvent(withFirstProject, {
        sequence: 2,
        eventId: asEventId("evt-project-create-second"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-second"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-second"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-second"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-second"),
          title: "Second",
          workspaceRoot: "/tmp/project-second",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-project-update-duplicate-root"),
            projectId: asProjectId("project-second"),
            workspaceRoot: "/tmp/project-first",
          },
          readModel,
        }),
      );

      expect(failure.message).toContain(
        "Active project 'project-first' already exists for workspace root '/tmp/project-first'.",
      );
    }),
  );
});
