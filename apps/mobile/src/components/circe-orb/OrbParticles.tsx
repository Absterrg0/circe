import { useMemo } from "react";
import { Circle, Group, useClock } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import { ORB_PALETTE, alphaColor, hash01 } from "./orbTokens";

const PARTICLE_COUNT = 12;
const GROUP_COUNT = 3;

interface Particle {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly alpha: number;
}

/**
 * One dot. Its colour is a derived value so the eased `amount` reaches the
 * alpha on the UI thread: setting it from React would either re-render on the
 * transition or need a group layer, and a layer is what draws a soft square
 * around soft edges on some Android GPUs.
 */
function ParticleDot({
  particle,
  amount,
}: {
  readonly particle: Particle;
  readonly amount: SharedValue<number>;
}) {
  const color = useDerivedValue(
    () => alphaColor(ORB_PALETTE.peach, particle.alpha * Math.min(1, Math.max(0, amount.value))),
    [amount, particle.alpha],
  );
  return <Circle cx={particle.x} cy={particle.y} r={particle.r} color={color} />;
}

/**
 * Microscopic grain suspended around the sphere.
 *
 * Not sparkles and not stars. These sit at the edge of perception: a couple of
 * pixels across, extremely low alpha, drifting upward a pixel or two over
 * seconds. They exist so the space around Circe feels inhabited rather than
 * empty. If you can consciously watch a particle move, it is too strong.
 *
 * The particles are split across three groups with different, incommensurate
 * drift periods so they never move in visible unison.
 */
export function OrbParticles({
  centerX,
  centerY,
  radius,
  amount,
  reducedMotion,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly amount: SharedValue<number>;
  readonly reducedMotion: boolean;
}) {
  const clock = useClock();

  // The full set is always built, and `amount` scales each particle's alpha
  // rather than choosing how many exist. Changing the count on a state change
  // made grain appear in one frame; fading it keeps idle at zero while the
  // transition stays continuous.
  const groups = useMemo(() => {
    const buckets: Particle[][] = [[], [], []];
    for (let index = 0; index < PARTICLE_COUNT; index += 1) {
      const angle = hash01(index, 11) * Math.PI * 2;
      const distance = radius * (1.12 + hash01(index, 12) * 0.95);
      const bucket = buckets[index % GROUP_COUNT];
      if (bucket === undefined) continue;
      bucket.push({
        x: centerX + Math.cos(angle) * distance,
        y: centerY + Math.sin(angle) * distance * 0.72,
        r: 0.7 + hash01(index, 13) * 1.05,
        alpha: 0.05 + hash01(index, 14) * 0.09,
      });
    }
    return buckets;
  }, [centerX, centerY, radius]);

  // Three independent, slow drifts. Each returns a transform array so the whole
  // group moves without any per-particle work. The grain is faded, not
  // unmounted, so these keep running in idle — the guard returns a constant
  // there, which stops the transforms propagating to the renderer while the
  // dots are invisible.
  const driftA = useDerivedValue(
    () => [
      {
        translateY:
          reducedMotion || amount.value < 0.01 ? 0 : Math.sin((clock.value / 1000) * 0.21) * 1.6,
      },
    ],
    [amount, clock, reducedMotion],
  );
  const driftB = useDerivedValue(
    () => [
      {
        translateY:
          reducedMotion || amount.value < 0.01
            ? 0
            : Math.sin((clock.value / 1000) * 0.13 + 2.1) * 2.1,
      },
    ],
    [amount, clock, reducedMotion],
  );
  const driftC = useDerivedValue(
    () => [
      {
        translateY:
          reducedMotion || amount.value < 0.01
            ? 0
            : Math.sin((clock.value / 1000) * 0.17 + 4.3) * 1.2,
      },
    ],
    [amount, clock, reducedMotion],
  );
  const drifts = [driftA, driftB, driftC];

  return (
    <Group>
      {groups.map((particles, groupIndex) => (
        <Group key={groupIndex} transform={drifts[groupIndex]}>
          {particles.map((particle, particleIndex) => (
            <ParticleDot key={particleIndex} particle={particle} amount={amount} />
          ))}
        </Group>
      ))}
    </Group>
  );
}
