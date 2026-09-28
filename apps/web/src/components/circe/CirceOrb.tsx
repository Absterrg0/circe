import { useId, type CSSProperties } from "react";

import { cn } from "../../lib/utils";
import "./circe-orb.css";

/**
 * Presence states the orb can show. Loops run only while Circe is listening,
 * working or speaking; `offline` is a disabled voice client and runs nothing.
 */
export type CirceOrbState =
  | "idle"
  | "listening"
  | "working"
  | "speaking"
  | "attention"
  | "error"
  | "offline";

const ORB_SIZES = { xs: 20, sm: 28, md: 44, lg: 72, xl: 120 } as const;

/** The orb's copper rim, ported from the mobile orb shader and baked once. */
export const CIRCE_ORB_SHELL_SRC = "/circe-orb-shell.webp";

/**
 * Circe's presence while it is talking with you: dark glass with copper light
 * on its rim. It is never decoration and never a hero; pair it with visible
 * state text. Motion rotates or scales layers so nothing repaints.
 */
export function CirceOrb(props: {
  readonly state?: CirceOrbState;
  readonly size?: keyof typeof ORB_SIZES | number;
  readonly className?: string;
}) {
  const gradientId = useId();
  const size = typeof props.size === "number" ? props.size : ORB_SIZES[props.size ?? "md"];
  return (
    <span
      aria-hidden
      className={cn("ci-orb", size < 40 && "ci-orb--small", props.className)}
      data-state={props.state ?? "idle"}
      style={{ "--orb": `${size}px` } as CSSProperties}
    >
      <span className="ci-orb__atmosphere" />
      <span className="ci-orb__bloom" />
      <span className="ci-orb__body">
        <svg className="ci-orb__threads" viewBox="0 0 100 100" aria-hidden>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="1">
              <stop offset="0" stopColor="var(--orb-peach)" stopOpacity="0" />
              <stop offset="0.5" stopColor="var(--orb-peach)" stopOpacity="0.55" />
              <stop offset="1" stopColor="var(--orb-copper)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <g fill="none" stroke={`url(#${gradientId})`} className="ci-orb__drift">
            <path d="M-4 62 C 26 40, 62 80, 104 46" strokeWidth="0.7" />
            <path d="M-2 70 C 32 52, 60 88, 102 56" strokeWidth="0.4" opacity="0.6" />
            <path d="M0 40 C 40 58, 66 22, 104 36" strokeWidth="0.35" opacity="0.45" />
          </g>
        </svg>
      </span>
      <img className="ci-orb__shell" src={CIRCE_ORB_SHELL_SRC} alt="" draggable={false} />
      <span className="ci-orb__halo" />
    </span>
  );
}
