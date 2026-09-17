export const T3CODE_MOBILE_SLUG = "circe-mobile" as const;

export interface ExpoOwnershipEnvironment {
  readonly T3CODE_EXPO_OWNER?: string;
  readonly T3CODE_EXPO_PROJECT_ID?: string;
}

export interface ExpoOwnership {
  readonly slug: typeof T3CODE_MOBILE_SLUG;
  readonly owner?: string;
  readonly projectId?: string;
  readonly updatesUrl?: string;
}

/** Resolve the optional Circe-owned EAS project without inheriting upstream identity. */
export function resolveExpoOwnership(environment: ExpoOwnershipEnvironment): ExpoOwnership {
  const owner = environment.T3CODE_EXPO_OWNER?.trim() || undefined;
  const projectId = environment.T3CODE_EXPO_PROJECT_ID?.trim() || undefined;

  return {
    slug: T3CODE_MOBILE_SLUG,
    ...(owner ? { owner } : {}),
    ...(projectId
      ? {
          projectId,
          updatesUrl: `https://u.expo.dev/${projectId}`,
        }
      : {}),
  };
}
