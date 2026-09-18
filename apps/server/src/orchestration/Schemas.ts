import {
  ProjectCreatedPayload as ContractsProjectCreatedPayloadSchema,
  ProjectMetaUpdatedPayload as ContractsProjectMetaUpdatedPayloadSchema,
  ProjectDeletedPayload as ContractsProjectDeletedPayloadSchema,
  ThreadDeletedPayload as ContractsThreadDeletedPayloadSchema,
} from "@circe/contracts/legacy-orchestration";

// Server-internal alias surface, backed by contract schemas as the source of truth.
// Agent thread/turn payload schemas moved to orchestration V2; only the project
// events and the `thread.delete` cascade the V1 engine still decides remain.
export const ProjectCreatedPayload = ContractsProjectCreatedPayloadSchema;
export const ProjectMetaUpdatedPayload = ContractsProjectMetaUpdatedPayloadSchema;
export const ProjectDeletedPayload = ContractsProjectDeletedPayloadSchema;

export const ThreadDeletedPayload = ContractsThreadDeletedPayloadSchema;
