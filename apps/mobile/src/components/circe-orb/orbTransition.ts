import { useEffect } from "react";
import { Easing, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";

import { resolveOrbParams, type OrbStateParams } from "./orbState";
import type { CirceOrbState } from "./types";

/**
 * The orb's state changes are a cross-fade, not a cut.
 *
 * Every parameter in `OrbStateParams` is a plain number, so switching state
 * used to rewrite all ten at once: the bloom jumped, the fiber field doubled
 * its drift speed mid-frame, grain appeared in a single frame, and the ribbon
 * changed shape between two renders. Idle to listening is the transition the
 * user actually watches, and it read as a snap inside an otherwise cinematic
 * scene.
 *
 * Each parameter now eases toward its target over the same window, so the orb
 * arrives at the listening look on the same beat the chrome does.
 */
export const ORB_STATE_TRANSITION_MS = 520;

export type OrbAnimatedParams = {
  readonly [K in keyof OrbStateParams]: SharedValue<number>;
};

/**
 * One parameter, eased. Called once per key below in a fixed order, so the
 * hook rules hold and no shared value outlives the orb.
 *
 * `duration === 0` assigns the target directly for reduced motion, where an
 * eased transition is the thing being asked to stop.
 */
function useOrbParam(target: number, duration: number): SharedValue<number> {
  const value = useSharedValue(target);
  useEffect(() => {
    value.value =
      duration === 0 ? target : withTiming(target, { duration, easing: Easing.inOut(Easing.quad) });
  }, [duration, target, value]);
  return value;
}

export function useOrbTransition(state: CirceOrbState, reducedMotion: boolean): OrbAnimatedParams {
  // Targets come from the unreduced preset: `resolveOrbParams` reports an
  // infinite drift cycle under reduced motion, which is not a value a timing
  // animation can hold. Stillness is expressed through `motionScale` instead,
  // which is the one parameter reduced motion genuinely zeroes.
  const target = resolveOrbParams(state);
  const duration = reducedMotion ? 0 : ORB_STATE_TRANSITION_MS;

  return {
    fieldAlpha: useOrbParam(target.fieldAlpha, duration),
    fieldAmplitude: useOrbParam(target.fieldAmplitude, duration),
    fieldCycleSeconds: useOrbParam(target.fieldCycleSeconds, duration),
    rimIntensity: useOrbParam(target.rimIntensity, duration),
    interiorThreads: useOrbParam(target.interiorThreads, duration),
    bloomIntensity: useOrbParam(target.bloomIntensity, duration),
    volumeIntensity: useOrbParam(target.volumeIntensity, duration),
    coreWarmth: useOrbParam(target.coreWarmth, duration),
    particleAmount: useOrbParam(target.particleAmount, duration),
    motionScale: useOrbParam(reducedMotion ? 0 : target.motionScale, duration),
    energyResponse: useOrbParam(target.energyResponse, duration),
  };
}
