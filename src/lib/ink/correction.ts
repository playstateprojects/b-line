import { nearestPointOnStroke, softenStroke, tangentAt } from './geometry';
import type { InkPoint, InkSettings, InkStroke } from './types';

export type CorrectionCandidate = {
  strokeIndex: number;
  score: number;
  coverage: number;
};

function alignment(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x * b.x + a.y * b.y);
}

export function findCorrectionCandidate(
  incoming: InkPoint[],
  strokes: InkStroke[],
  settings: InkSettings,
  zoom: number
): CorrectionCandidate | null {
  if (incoming.length < 2 || strokes.length === 0) return null;

  const radiusWorld = settings.attractionRadiusPx / zoom;
  const sampleStride = Math.max(1, Math.floor(incoming.length / 48));
  let best: CorrectionCandidate | null = null;

  strokes.forEach((stroke, strokeIndex) => {
    if (stroke.points.length < 2) return;

    let score = 0;
    let covered = 0;
    let sampled = 0;

    for (let index = 0; index < incoming.length; index += sampleStride) {
      const point = incoming[index];
      const nearest = nearestPointOnStroke(point, stroke.points);
      if (!nearest) continue;

      sampled += 1;
      const tangent = tangentAt(incoming, index);
      const directionMatch = alignment(tangent, nearest.tangent);

      if (nearest.distance <= radiusWorld && directionMatch >= settings.directionTolerance) {
        const proximity = 1 - nearest.distance / radiusWorld;
        score += proximity * proximity * directionMatch;
        covered += 1;
      }
    }

    if (sampled === 0) return;

    const coverage = covered / sampled;
    const normalizedScore = score / sampled;

    if (coverage >= 0.22 && normalizedScore >= 0.08) {
      if (!best || normalizedScore > best.score) {
        best = { strokeIndex, score: normalizedScore, coverage };
      }
    }
  });

  return best;
}

export function guideIncomingStroke(
  incoming: InkPoint[],
  target: InkPoint[],
  settings: InkSettings,
  zoom: number
): InkPoint[] {
  const radiusWorld = settings.attractionRadiusPx / zoom;

  return incoming.map((point, index) => {
    const nearest = nearestPointOnStroke(point, target);
    if (!nearest || nearest.distance > radiusWorld) return { ...point };

    const directionMatch = alignment(tangentAt(incoming, index), nearest.tangent);
    if (directionMatch < settings.directionTolerance) return { ...point };

    const proximity = 1 - nearest.distance / radiusWorld;
    const influence = settings.newStrokePull * proximity * proximity * directionMatch;

    return {
      ...point,
      x: point.x + (nearest.point.x - point.x) * influence,
      y: point.y + (nearest.point.y - point.y) * influence
    };
  });
}

export function correctStroke(
  target: InkStroke,
  incoming: InkPoint[],
  settings: InkSettings,
  zoom: number
): InkStroke {
  const radiusWorld = settings.attractionRadiusPx / zoom;
  const guidedIncoming = guideIncomingStroke(incoming, target.points, settings, zoom);

  const corrected = target.points.map((point, index) => {
    const nearest = nearestPointOnStroke(point, guidedIncoming);
    if (!nearest || nearest.distance > radiusWorld) return { ...point };

    const directionMatch = alignment(tangentAt(target.points, index), nearest.tangent);
    if (directionMatch < settings.directionTolerance) return { ...point };

    const proximity = 1 - nearest.distance / radiusWorld;
    const influence = settings.correctionStrength * Math.pow(proximity, 1.35) * directionMatch;

    return {
      ...point,
      x: point.x + (nearest.point.x - point.x) * influence,
      y: point.y + (nearest.point.y - point.y) * influence,
      pressure: point.pressure + (nearest.point.pressure - point.pressure) * influence * 0.25
    };
  });

  return {
    ...target,
    points: softenStroke(corrected, 0.12, 1),
    revisions: target.revisions + 1
  };
}
