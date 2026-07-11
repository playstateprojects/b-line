import type { InkPoint } from './types';

export type NearestPoint = {
  point: InkPoint;
  distance: number;
  segmentIndex: number;
  t: number;
  tangent: { x: number; y: number };
};

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const distance = (a: Pick<InkPoint, 'x' | 'y'>, b: Pick<InkPoint, 'x' | 'y'>): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

export function normalize(x: number, y: number): { x: number; y: number } {
  const length = Math.hypot(x, y);
  if (length < 1e-6) return { x: 1, y: 0 };
  return { x: x / length, y: y / length };
}

export function tangentAt(points: InkPoint[], index: number): { x: number; y: number } {
  if (points.length < 2) return { x: 1, y: 0 };
  const before = points[Math.max(0, index - 1)];
  const after = points[Math.min(points.length - 1, index + 1)];
  return normalize(after.x - before.x, after.y - before.y);
}

export function nearestPointOnStroke(point: InkPoint, stroke: InkPoint[]): NearestPoint | null {
  if (stroke.length < 2) return null;

  let best: NearestPoint | null = null;

  for (let index = 0; index < stroke.length - 1; index += 1) {
    const a = stroke[index];
    const b = stroke[index + 1];
    const abX = b.x - a.x;
    const abY = b.y - a.y;
    const lengthSquared = abX * abX + abY * abY;
    const t = lengthSquared > 1e-8
      ? clamp(((point.x - a.x) * abX + (point.y - a.y) * abY) / lengthSquared, 0, 1)
      : 0;

    const projected: InkPoint = {
      x: a.x + abX * t,
      y: a.y + abY * t,
      pressure: a.pressure + (b.pressure - a.pressure) * t,
      time: a.time + (b.time - a.time) * t
    };
    const projectedDistance = distance(point, projected);

    if (!best || projectedDistance < best.distance) {
      best = {
        point: projected,
        distance: projectedDistance,
        segmentIndex: index,
        t,
        tangent: normalize(abX, abY)
      };
    }
  }

  return best;
}

export function resampleStroke(points: InkPoint[], spacing: number): InkPoint[] {
  if (points.length < 2) return points;

  const output: InkPoint[] = [{ ...points[0] }];
  let previous = { ...points[0] };
  let carried = 0;

  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    let segmentLength = distance(previous, current);

    if (segmentLength < 1e-6) continue;

    while (carried + segmentLength >= spacing) {
      const t = (spacing - carried) / segmentLength;
      const inserted: InkPoint = {
        x: previous.x + (current.x - previous.x) * t,
        y: previous.y + (current.y - previous.y) * t,
        pressure: previous.pressure + (current.pressure - previous.pressure) * t,
        time: previous.time + (current.time - previous.time) * t
      };
      output.push(inserted);
      previous = inserted;
      segmentLength = distance(previous, current);
      carried = 0;
    }

    carried += segmentLength;
    previous = { ...current };
  }

  const last = points[points.length - 1];
  if (distance(output[output.length - 1], last) > spacing * 0.25) {
    output.push({ ...last });
  }

  return output;
}

export function softenStroke(points: InkPoint[], amount = 0.18, passes = 1): InkPoint[] {
  if (points.length < 3) return points;
  let output = points.map((point) => ({ ...point }));

  for (let pass = 0; pass < passes; pass += 1) {
    output = output.map((point, index, source) => {
      if (index === 0 || index === source.length - 1) return point;
      const before = source[index - 1];
      const after = source[index + 1];
      return {
        ...point,
        x: point.x * (1 - amount) + ((before.x + after.x) / 2) * amount,
        y: point.y * (1 - amount) + ((before.y + after.y) / 2) * amount,
        pressure: point.pressure * (1 - amount) + ((before.pressure + after.pressure) / 2) * amount
      };
    });
  }

  return output;
}
