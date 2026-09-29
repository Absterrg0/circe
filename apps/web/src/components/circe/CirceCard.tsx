import { ArrowRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { CirceTone } from "./CirceStatusGlyph";

/** A card's title row: what it holds, how many, and where to see all of it. */
export function CirceCardHeader({
  title,
  count,
  countTone,
  subtitle,
  link,
}: {
  readonly title: ReactNode;
  readonly count?: number;
  readonly countTone?: CirceTone | undefined;
  readonly subtitle?: string | undefined;
  readonly link?: ReactNode;
}) {
  return (
    <header className="circe-card__header">
      <h2 className="circe-card__title">
        {title}
        {count !== undefined && count > 0 ? (
          <span className="circe-count" data-tone={countTone}>
            {count}
          </span>
        ) : null}
      </h2>
      {subtitle ? <span className="circe-card__subtitle">{subtitle}</span> : null}
      {link}
    </header>
  );
}

/** Label for a card link that leads somewhere else ("View all", "Manage"). */
export function CirceCardLinkLabel({ children }: { readonly children: ReactNode }) {
  return (
    <>
      {children}
      <ArrowRightIcon aria-hidden />
    </>
  );
}
