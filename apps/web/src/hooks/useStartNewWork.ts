import { scopeProjectRef } from "@circe/client/environment";
import { useCallback, useMemo } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { useChatSpaces, useUserProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useNewThreadHandler } from "./useHandleNewThread";

/**
 * The three ways to start something, shared by the rail's New menu and Home.
 * A chat opens in this device's chat space; an agent thread needs a project,
 * so it creates directly when there is one and asks which when there are
 * several.
 */
export function useStartNewWork() {
  const userProjects = useUserProjects();
  const chatSpaces = useChatSpaces();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const handleNewThread = useNewThreadHandler();

  const chatSpaceRef = useMemo(() => {
    const space =
      chatSpaces.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
      chatSpaces[0];
    return space === undefined ? null : scopeProjectRef(space.environmentId, space.id);
  }, [chatSpaces, primaryEnvironmentId]);

  const startChat = useCallback(() => {
    if (chatSpaceRef !== null) void handleNewThread(chatSpaceRef);
  }, [chatSpaceRef, handleNewThread]);

  const addProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  const startAgentThread = useCallback(() => {
    const [onlyProject] = userProjects;
    if (onlyProject === undefined) {
      addProject();
    } else if (userProjects.length === 1) {
      void handleNewThread(scopeProjectRef(onlyProject.environmentId, onlyProject.id));
    } else {
      openCommandPalette({ open: "new-thread-in" });
    }
  }, [addProject, handleNewThread, userProjects]);

  return {
    startChat: chatSpaceRef === null ? null : startChat,
    startAgentThread,
    addProject,
    hasProjects: userProjects.length > 0,
  };
}
