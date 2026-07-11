export type InkPoint = {
  x: number;
  y: number;
  pressure: number;
  time: number;
};

export type InkStroke = {
  id: string;
  points: InkPoint[];
  createdAt: number;
  revisions: number;
};

export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

export type InkSettings = {
  attractionRadiusPx: number;
  correctionStrength: number;
  newStrokePull: number;
  directionTolerance: number;
  baseWidth: number;
};
