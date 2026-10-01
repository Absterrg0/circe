/**
 * A small isometric projection for the site's illustrations. Scenes are
 * described in grid units and drawn as plain SVG polygons, so every block on
 * the page shares one angle, one stroke, and one palette.
 *
 * Axes: +x runs down and to the right, +y runs down and to the left, +z is up.
 * The three faces a viewer sees are the top, the face at the far y edge
 * (front-left), and the face at the far x edge (front-right).
 */
const COS_30 = Math.cos(Math.PI / 6);
const SIN_30 = 0.5;

export type IsoPoint = readonly [x: number, y: number, z?: number];

export interface IsoBox {
  readonly top: string;
  readonly left: string;
  readonly right: string;
}

export function makeIso(unit: number, originX: number, originY: number) {
  const project = (x: number, y: number, z = 0): readonly [number, number] => [
    originX + (x - y) * COS_30 * unit,
    originY + (x + y) * SIN_30 * unit - z * unit,
  ];
  const points = (list: ReadonlyArray<IsoPoint>): string =>
    list
      .map(([x, y, z]) => project(x, y, z))
      .map(([sx, sy]) => `${sx.toFixed(1)},${sy.toFixed(1)}`)
      .join(" ");

  /** The three visible faces of a block at (x, y, z) sized (w, d, h). */
  const box = (x: number, y: number, z: number, w: number, d: number, h: number): IsoBox => ({
    top: points([
      [x, y, z + h],
      [x + w, y, z + h],
      [x + w, y + d, z + h],
      [x, y + d, z + h],
    ]),
    left: points([
      [x, y + d, z + h],
      [x + w, y + d, z + h],
      [x + w, y + d, z],
      [x, y + d, z],
    ]),
    right: points([
      [x + w, y, z + h],
      [x + w, y + d, z + h],
      [x + w, y + d, z],
      [x + w, y, z],
    ]),
  });

  /** A rectangle drawn on the front-left face of a block: the plane at a fixed y. */
  const onLeftFace = (y: number, x0: number, z0: number, x1: number, z1: number): string =>
    points([
      [x0, y, z1],
      [x1, y, z1],
      [x1, y, z0],
      [x0, y, z0],
    ]);

  /** A flat rectangle on the plane at a fixed z. */
  const onFloor = (x0: number, y0: number, x1: number, y1: number, z = 0): string =>
    points([
      [x0, y0, z],
      [x1, y0, z],
      [x1, y1, z],
      [x0, y1, z],
    ]);

  return { project, points, box, onLeftFace, onFloor };
}

/** An SVG data URI of one isometric grid tile, for CSS backgrounds. */
export function isoGridDataUri(cell: number, stroke: string, strokeWidth = 1): string {
  const width = 2 * COS_30 * cell;
  const height = cell;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(3)}" height="${height}" viewBox="0 0 ${width.toFixed(3)} ${height}"><path d="M0 ${height / 2}L${(width / 2).toFixed(3)} 0L${width.toFixed(3)} ${height / 2}L${(width / 2).toFixed(3)} ${height}Z" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
