import { cn } from "../../lib/utils";
import "./circe-surfaces.css";

/** Presence states the orb can show; motion runs only for listening and working. */
export type CirceOrbState = "idle" | "listening" | "working" | "attention" | "error";

/**
 * Circe's signature mark in the product: a warm sphere drawn with the brand
 * gradient. It is decorative; callers pair it with visible state text.
 */
export function CirceOrb(props: {
  readonly state?: CirceOrbState;
  readonly size?: "sm" | "md" | "lg" | "xl";
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("circe-orb", props.className)}
      data-state={props.state ?? "idle"}
      data-size={props.size ?? "lg"}
    />
  );
}
