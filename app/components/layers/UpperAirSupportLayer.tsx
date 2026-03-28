"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useEarthLayer } from "./EarthBase";
import {
  fetchMslContours,
  fetchUpperAirSupportFrame,
  fetchUpperAirSupportManifest,
  potentialVorticityApiUrl,
  type MslContoursFile,
  type UpperAirSupportFeaturePoint,
  type UpperAirSupportFrame,
  type UpperAirSupportManifest,
  type UpperAirSupportPoint,
} from "../utils/ApiResponses";
import { latLonToVec3 } from "../utils/EarthUtils";
import { useControls } from "../../state/controlsStore";
import { configureDataTexture } from "./shaderUtils";

type StoryLayerKey =
  | "verticalVelocity"
  | "stackedStructure"
  | "pvDriver"
  | "tiltLink"
  | "liftChain";

type StoryLayerState = Record<StoryLayerKey, boolean>;

type UpperAirSupportStyleState = {
  ascentThreshold: number;
  ascentOpacity: number;
  ascentGamma: number;
  divergenceThreshold: number;
  arrowScale: number;
  arrowOpacity: number;
};

type UpperAirSupportSample = {
  latitude: number;
  longitude: number;
  ascent500_pa_s: number;
  divergence250_s1: number;
};

type FrameGrid = {
  lats: number[];
  lons: number[];
  nLat: number;
  nLon: number;
  samples: Array<Array<UpperAirSupportSample | undefined>>;
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
};

type StaticBuildResult = {
  group: THREE.Group;
  markerObjectsByHourKey: Map<string, THREE.Object3D[]>;
};

type StoryContourData = {
  upper250: MslContoursFile | null;
  lower925: MslContoursFile | null;
};

type FrameVisual = {
  group: THREE.Group;
  layers: Partial<Record<StoryLayerKey, THREE.Object3D>>;
};

type FrameDataEntry =
  | { status: "loading"; promise: Promise<void> }
  | { status: "ready"; frame: UpperAirSupportFrame }
  | { status: "missing" | "error" };

type ContourDataEntry =
  | { status: "loading"; promise: Promise<void> }
  | { status: "ready"; data: StoryContourData }
  | { status: "missing" | "error"; data: StoryContourData | null };

type PvTextureEntry =
  | { status: "loading"; promise: Promise<void> }
  | { status: "ready"; texture: THREE.Texture }
  | { status: "missing" | "error" };

const STORY_LAYER_KEYS: StoryLayerKey[] = [
  "verticalVelocity",
  "stackedStructure",
  "pvDriver",
  "tiltLink",
  "liftChain",
];
const CONTOUR_HALF_SPAN_LAT = 10;
const CONTOUR_HALF_SPAN_LON = 16;

function clamp01(x: number) {
  return THREE.MathUtils.clamp(x, 0, 1);
}

function toHourlyKey(timestamp: string) {
  const trimmed = timestamp.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(trimmed);
  if (match) return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:00`;

  const dt = new Date(trimmed);
  if (Number.isFinite(dt.getTime())) {
    const y = dt.getUTCFullYear();
    const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    const h = String(dt.getUTCHours()).padStart(2, "0");
    return `${y}-${mo}-${d}T${h}:00`;
  }

  return trimmed;
}

function splitPolyline(
  points: Array<[number, number]>,
  maxStepDeg = 2.0
): Array<Array<[number, number]>> {
  if (!points || points.length < 2) return [];

  const pieces: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const next = points[i];

    let dLon = Math.abs(Number(next[0]) - Number(prev[0]));
    if (dLon > 180) dLon = 360 - dLon;
    const dLat = Math.abs(Number(next[1]) - Number(prev[1]));

    if (dLon > maxStepDeg || dLat > maxStepDeg) {
      if (current.length >= 2) pieces.push(current);
      current = [next];
      continue;
    }

    current.push(next);
  }

  if (current.length >= 2) pieces.push(current);
  return pieces;
}

function wrappedLonDelta(a: number, b: number) {
  let d = Math.abs(a - b);
  if (d > 180) d = 360 - d;
  return d;
}

function pointInLocalBox(
  lat: number,
  lon: number,
  centerLat: number,
  centerLon: number,
  halfLat: number,
  halfLon: number
) {
  return (
    Math.abs(lat - centerLat) <= halfLat &&
    wrappedLonDelta(lon, centerLon) <= halfLon
  );
}

function clipPolylineToBox(
  points: Array<[number, number]>,
  centerLat: number,
  centerLon: number,
  halfLat: number,
  halfLon: number
) {
  const pieces: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];

  for (const point of points) {
    const inside = pointInLocalBox(
      point[1],
      point[0],
      centerLat,
      centerLon,
      halfLat,
      halfLon
    );
    if (inside) {
      current.push(point);
      continue;
    }
    if (current.length >= 2) pieces.push(current);
    current = [];
  }

  if (current.length >= 2) pieces.push(current);
  return pieces;
}

function polylineDistanceToFeature(
  points: Array<[number, number]>,
  feature: UpperAirSupportFeaturePoint | null
) {
  if (!feature) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const [lon, lat] of points) {
    const d = Math.hypot(lat - feature.latitude, wrappedLonDelta(lon, feature.longitude));
    if (d < best) best = d;
  }
  return best;
}

function disposeObjectTree(root: THREE.Object3D) {
  root.traverse((obj) => {
    const disposable = obj as THREE.Object3D & {
      geometry?: { dispose?: () => void };
      material?: THREE.Material | THREE.Material[];
    };

    disposable.geometry?.dispose?.();
    const material = disposable.material;
    if (Array.isArray(material)) {
      for (const m of material) m.dispose();
    } else {
      material?.dispose();
    }
  });
}

function setMaterialOpacity(
  material: THREE.Material | THREE.Material[] | undefined,
  opacity: number
) {
  if (!material) return;
  const mats = Array.isArray(material) ? material : [material];
  for (const mat of mats) {
    if (mat instanceof THREE.ShaderMaterial) {
      const uniform = mat.uniforms?.uAlphaMul;
      if (uniform) {
        uniform.value = opacity;
        continue;
      }
    }

    const target = mat as THREE.Material & {
      opacity?: number;
      transparent?: boolean;
      userData: Record<string, unknown>;
    };
    if (typeof target.opacity !== "number") continue;
    const baseOpacity =
      typeof target.userData.__baseOpacity === "number"
        ? (target.userData.__baseOpacity as number)
        : target.opacity;
    target.userData.__baseOpacity = baseOpacity;
    target.transparent = true;
    target.opacity = baseOpacity * opacity;
  }
}

function makeLine(
  points: Array<[number, number]>,
  radius: number,
  lift: number,
  material: THREE.LineBasicMaterial
) {
  const positions = new Float32Array(points.length * 3);
  points.forEach(([lon, lat], idx) => {
    const v = latLonToVec3(lat, lon, radius + lift);
    positions[idx * 3 + 0] = v.x;
    positions[idx * 3 + 1] = v.y;
    positions[idx * 3 + 2] = v.z;
  });

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const line = new THREE.Line(geom, material);
  line.frustumCulled = false;
  return line;
}

function makePathDots(
  points: UpperAirSupportPoint[],
  radius: number,
  lift: number,
  colorHex: number,
  size: number
) {
  const positions = new Float32Array(points.length * 3);
  points.forEach((point, idx) => {
    const v = latLonToVec3(point.latitude, point.longitude, radius + lift);
    positions[idx * 3 + 0] = v.x;
    positions[idx * 3 + 1] = v.y;
    positions[idx * 3 + 2] = v.z;
  });

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: colorHex,
    size,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    depthTest: true,
  });
  const dots = new THREE.Points(geom, mat);
  dots.frustumCulled = false;
  return dots;
}

function makeVertexAlphaMesh(
  positions: Float32Array,
  indices: Uint16Array | Uint32Array,
  colors: Float32Array,
  alphas: Float32Array,
  renderOrder: number
) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions.slice(), 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geom.setAttribute("alpha", new THREE.BufferAttribute(alphas, 1));
  geom.setIndex(new THREE.BufferAttribute(indices.slice(), 1));
  geom.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uAlphaMul: { value: 1.0 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    vertexShader: `
      attribute vec3 color;
      attribute float alpha;
      varying vec3 vColor;
      varying float vAlpha;

      void main() {
        vColor = color;
        vAlpha = alpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      uniform float uAlphaMul;

      void main() {
        gl_FragColor = vec4(vColor, vAlpha * uAlphaMul);
      }
    `,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  return mesh;
}

function buildFrameGrid(
  frame: UpperAirSupportFrame,
  radius: number,
  lift: number
): FrameGrid | null {
  const lats = frame.grid_latitudes ?? [];
  const lons = frame.grid_longitudes ?? [];
  const nLat = lats.length;
  const nLon = lons.length;
  const count = nLat * nLon;
  const cells = frame.cells ?? [];
  if (nLat < 2 || nLon < 2 || count === 0) return null;
  if (cells.length < count) return null;

  const positions = new Float32Array(count * 3);
  const samples: Array<Array<UpperAirSupportSample | undefined>> = Array.from(
    { length: nLat },
    () => Array<UpperAirSupportSample | undefined>(nLon)
  );

  let vertexIndex = 0;
  for (let latIdx = 0; latIdx < nLat; latIdx++) {
    for (let lonIdx = 0; lonIdx < nLon; lonIdx++) {
      const lat = lats[latIdx];
      const lon = lons[lonIdx];
      const cell = cells[vertexIndex];
      samples[latIdx][lonIdx] = cell
        ? {
            latitude: lat,
            longitude: lon,
            ascent500_pa_s: cell[3],
            divergence250_s1: cell[4],
          }
        : undefined;

      const v = latLonToVec3(lat, lon, radius + lift);
      positions[vertexIndex * 3 + 0] = v.x;
      positions[vertexIndex * 3 + 1] = v.y;
      positions[vertexIndex * 3 + 2] = v.z;
      vertexIndex += 1;
    }
  }

  const triangleCount = (nLat - 1) * (nLon - 1) * 2;
  const indices = new (count > 65535 ? Uint32Array : Uint16Array)(
    triangleCount * 3
  );
  let triIndex = 0;
  for (let latIdx = 0; latIdx < nLat - 1; latIdx++) {
    for (let lonIdx = 0; lonIdx < nLon - 1; lonIdx++) {
      const a = latIdx * nLon + lonIdx;
      const b = a + 1;
      const c = a + nLon;
      const d = c + 1;

      indices[triIndex++] = a;
      indices[triIndex++] = c;
      indices[triIndex++] = b;
      indices[triIndex++] = b;
      indices[triIndex++] = c;
      indices[triIndex++] = d;
    }
  }

  return { lats, lons, nLat, nLon, samples, positions, indices };
}

function makeVerticalVelocityMesh(
  frameGrid: FrameGrid,
  manifest: UpperAirSupportManifest,
  style: UpperAirSupportStyleState
) {
  const count = frameGrid.nLat * frameGrid.nLon;
  const colors = new Float32Array(count * 3);
  const alphas = new Float32Array(count);

  const ascentRef = Math.max(
    manifest.summary.ascent_p95_pa_s ?? manifest.summary.ascent_max_pa_s ?? 0,
    1e-6
  );
  const threshold = clamp01(style.ascentThreshold) * ascentRef;
  const denom = Math.max(ascentRef - threshold, 1e-6);

  const warmEdge = new THREE.Color(0xffd8ca);
  const warmCore = new THREE.Color(0xff5a52);

  let vertexIndex = 0;
  for (let latIdx = 0; latIdx < frameGrid.nLat; latIdx++) {
    for (let lonIdx = 0; lonIdx < frameGrid.nLon; lonIdx++) {
      const sample = frameGrid.samples[latIdx][lonIdx];
      const ascent = sample?.ascent500_pa_s ?? 0;
      const t = clamp01((ascent - threshold) / denom);
      const shaped = Math.pow(t, Math.max(style.ascentGamma, 0.01));
      const color = warmEdge.clone().lerp(warmCore, Math.pow(t, 0.8));

      colors[vertexIndex * 3 + 0] = color.r;
      colors[vertexIndex * 3 + 1] = color.g;
      colors[vertexIndex * 3 + 2] = color.b;
      alphas[vertexIndex] = style.ascentOpacity * shaped;
      vertexIndex += 1;
    }
  }

  return makeVertexAlphaMesh(frameGrid.positions, frameGrid.indices, colors, alphas, 70);
}

function makeDivergencePulseMesh(
  frameGrid: FrameGrid,
  manifest: UpperAirSupportManifest,
  style: UpperAirSupportStyleState
) {
  const count = frameGrid.nLat * frameGrid.nLon;
  const colors = new Float32Array(count * 3);
  const alphas = new Float32Array(count);

  const divergenceRef = Math.max(
    manifest.summary.divergence250_p95_s1 ?? manifest.summary.divergence250_max_s1 ?? 0,
    1e-9
  );
  const threshold = clamp01(style.divergenceThreshold) * divergenceRef;
  const denom = Math.max(divergenceRef - threshold, 1e-9);
  const pulse = new THREE.Color(0xffefb8);

  let vertexIndex = 0;
  for (let latIdx = 0; latIdx < frameGrid.nLat; latIdx++) {
    for (let lonIdx = 0; lonIdx < frameGrid.nLon; lonIdx++) {
      const sample = frameGrid.samples[latIdx][lonIdx];
      const divergence = sample?.divergence250_s1 ?? 0;
      const t = clamp01((divergence - threshold) / denom);
      colors[vertexIndex * 3 + 0] = pulse.r;
      colors[vertexIndex * 3 + 1] = pulse.g;
      colors[vertexIndex * 3 + 2] = pulse.b;
      alphas[vertexIndex] = 0.05 + 0.58 * Math.pow(t, 1.7);
      vertexIndex += 1;
    }
  }

  const mesh = makeVertexAlphaMesh(frameGrid.positions, frameGrid.indices, colors, alphas, 76);
  mesh.userData.__pulseOpacity = {
    min: 0.55,
    max: 1.55,
    speed: 1.25,
    phase: 0.18,
  };
  return mesh;
}

function buildVerticalVelocityLayer(
  frame: UpperAirSupportFrame,
  manifest: UpperAirSupportManifest,
  style: UpperAirSupportStyleState,
  radius: number
) {
  const fieldLift = radius * 0.00295;
  const frameGrid = buildFrameGrid(frame, radius, fieldLift);
  if (!frameGrid) return null;

  const group = new THREE.Group();
  group.name = "upper-air-vertical-velocity";
  group.frustumCulled = false;

  group.add(makeVerticalVelocityMesh(frameGrid, manifest, style));
  group.add(makeDivergencePulseMesh(frameGrid, manifest, style));
  return group;
}

function makeArrowGeometry() {
  const shaftH = 0.7;
  const headH = 0.3;
  const shaftR = 0.04;
  const headR = 0.1;

  const shaft = new THREE.CylinderGeometry(shaftR, shaftR, shaftH, 10, 1, true);
  shaft.translate(0, shaftH * 0.5, 0);
  const head = new THREE.ConeGeometry(headR, headH, 14, 1, true);
  head.translate(0, shaftH + headH * 0.5, 0);

  const merged = BufferGeometryUtils.mergeGeometries([shaft, head], false);
  merged.computeVertexNormals();
  return merged;
}

function tangentEastNorth(latDeg: number, lonDeg: number, radius: number) {
  const eps = 1e-3;
  const p = latLonToVec3(latDeg, lonDeg, radius);
  const pLon = latLonToVec3(latDeg, lonDeg + eps, radius);
  const pLat = latLonToVec3(latDeg + eps, lonDeg, radius);

  const dLon = pLon.sub(p);
  const dLat = pLat.sub(p);
  const n = p.clone().normalize();
  const east = dLon.sub(n.clone().multiplyScalar(dLon.dot(n))).normalize();
  const north = dLat.sub(n.clone().multiplyScalar(dLat.dot(n))).normalize();
  return { p, east, north, normal: n };
}

function orientSurfaceGroup(
  feature: UpperAirSupportFeaturePoint,
  radius: number,
  lift: number
) {
  const position = latLonToVec3(feature.latitude, feature.longitude, radius + lift);
  const normal = position.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    normal
  );
  return { position, normal, quaternion };
}

function makeFeatureMarker(
  feature: UpperAirSupportFeaturePoint | null,
  radius: number,
  lift: number,
  colorHex: number,
  sizeScale: number,
  renderOrder: number
) {
  if (!feature) return null;
  const geom = new THREE.SphereGeometry(radius * sizeScale, 16, 16);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(colorHex),
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    depthTest: true,
  });
  const marker = new THREE.Mesh(geom, mat);
  marker.position.copy(
    latLonToVec3(feature.latitude, feature.longitude, radius + lift)
  );
  marker.frustumCulled = false;
  marker.renderOrder = renderOrder;
  return marker;
}

function makeFeatureConnector(
  start: UpperAirSupportFeaturePoint | null,
  startLift: number,
  end: UpperAirSupportFeaturePoint | null,
  endLift: number,
  radius: number,
  colorHex: number,
  opacity: number,
  renderOrder: number
) {
  if (!start || !end) return null;

  const positions = new Float32Array(6);
  const a = latLonToVec3(start.latitude, start.longitude, radius + startLift);
  const b = latLonToVec3(end.latitude, end.longitude, radius + endLift);
  positions[0] = a.x;
  positions[1] = a.y;
  positions[2] = a.z;
  positions[3] = b.x;
  positions[4] = b.y;
  positions[5] = b.z;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color(colorHex),
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: true,
  });
  const line = new THREE.Line(geom, mat);
  line.frustumCulled = false;
  line.renderOrder = renderOrder;
  return line;
}

function makePulseRing(
  feature: UpperAirSupportFeaturePoint | null,
  radius: number,
  lift: number,
  colorHex: number,
  ringScale: number,
  renderOrder: number,
  phase = 0
) {
  if (!feature) return null;

  const group = new THREE.Group();
  const { position, quaternion } = orientSurfaceGroup(feature, radius, lift);
  group.position.copy(position);
  group.quaternion.copy(quaternion);
  group.renderOrder = renderOrder;
  group.frustumCulled = false;

  const torus = new THREE.Mesh(
    new THREE.TorusGeometry(radius * ringScale, radius * ringScale * 0.12, 12, 48),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(colorHex),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      depthTest: true,
    })
  );
  group.add(torus);
  group.userData.__pulseScale = {
    baseScale: 1,
    amplitude: 0.18,
    speed: 1.25,
    phase,
  };
  group.userData.__pulseOpacity = {
    min: 0.18,
    max: 0.9,
    speed: 1.25,
    phase,
  };
  return group;
}

function makeSwirlMarker(
  feature: UpperAirSupportFeaturePoint | null,
  radius: number,
  lift: number,
  colorHex: number,
  renderOrder: number,
  phase = 0
) {
  if (!feature) return null;

  const group = new THREE.Group();
  const { position, quaternion } = orientSurfaceGroup(feature, radius, lift);
  group.position.copy(position);
  group.quaternion.copy(quaternion);
  group.renderOrder = renderOrder;
  group.frustumCulled = false;

  const baseRadius = radius * 0.015;
  for (let arm = 0; arm < 3; arm++) {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 28; i++) {
      const t = i / 28;
      const angle = 0.5 + t * 1.8 + arm * ((Math.PI * 2) / 3);
      const r = baseRadius * (0.25 + 0.9 * t);
      points.push(new THREE.Vector3(Math.cos(angle) * r, Math.sin(angle) * r, 0));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(colorHex),
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      depthTest: true,
    });
    const line = new THREE.Line(geom, mat);
    line.frustumCulled = false;
    group.add(line);
  }

  const center = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.0048, 14, 14),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(colorHex),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: true,
    })
  );
  group.add(center);

  group.userData.__spinZ = { speed: 0.55, phase };
  group.userData.__pulseOpacity = {
    min: 0.45,
    max: 1,
    speed: 1.1,
    phase,
  };
  return group;
}

function makeFlowDotsConnector(
  start: UpperAirSupportFeaturePoint | null,
  startLift: number,
  end: UpperAirSupportFeaturePoint | null,
  endLift: number,
  radius: number,
  colorHex: number,
  dotScale: number,
  renderOrder: number,
  phase = 0
) {
  if (!start || !end) return null;

  const group = new THREE.Group();
  group.renderOrder = renderOrder;
  group.frustumCulled = false;

  const startVec = latLonToVec3(start.latitude, start.longitude, radius + startLift);
  const endVec = latLonToVec3(end.latitude, end.longitude, radius + endLift);
  const geom = new THREE.SphereGeometry(radius * dotScale, 10, 10);
  const count = 12;

  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(colorHex),
      transparent: true,
      opacity: 0.15,
      depthWrite: false,
      depthTest: true,
    });
    const dot = new THREE.Mesh(geom.clone(), mat);
    dot.position.copy(startVec.clone().lerp(endVec, t));
    dot.userData.__flowT = t;
    dot.frustumCulled = false;
    group.add(dot);
  }

  group.userData.__flowDots = {
    speed: 0.36,
    width: 0.18,
    phase,
    minOpacity: 0.08,
    maxOpacity: 1.0,
  };
  return group;
}

function makeRadialArrowGlyph(
  feature: UpperAirSupportFeaturePoint | null,
  radius: number,
  lift: number,
  colorHex: number,
  inward: boolean,
  style: UpperAirSupportStyleState,
  renderOrder: number,
  phase = 0
) {
  if (!feature) return null;

  const group = new THREE.Group();
  const arrowGeom = makeArrowGeometry();
  const offset = 1.45;
  const length = 0.6 + 0.45 * style.arrowScale;
  const normalLift = 0.08;
  const up = new THREE.Vector3(0, 1, 0);
  const { p, east, north, normal } = tangentEastNorth(
    feature.latitude,
    feature.longitude,
    radius + lift
  );

  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const tangent = east
      .clone()
      .multiplyScalar(Math.cos(angle))
      .add(north.clone().multiplyScalar(Math.sin(angle)))
      .normalize();
    const dir = inward ? tangent.clone().multiplyScalar(-1) : tangent.clone();
    const pos = p
      .clone()
      .add(tangent.clone().multiplyScalar(offset))
      .add(normal.clone().multiplyScalar(normalLift));

    const mesh = new THREE.Mesh(
      arrowGeom.clone(),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(colorHex),
        transparent: true,
        opacity: 0.55 * style.arrowOpacity,
        depthWrite: false,
        depthTest: true,
      })
    );
    mesh.position.copy(pos);
    mesh.quaternion.setFromUnitVectors(up, dir);
    mesh.scale.set(0.42, length, 0.42);
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  group.userData.__pulseOpacity = {
    min: 0.45,
    max: 1,
    speed: 1.15,
    phase,
  };
  return group;
}

function addIfPresent(group: THREE.Group, object: THREE.Object3D | null) {
  if (object) group.add(object);
}

function buildStaticContext(
  manifest: UpperAirSupportManifest,
  radius: number
): StaticBuildResult {
  const points = [...manifest.points].sort((a, b) => a.step_hour - b.step_hour);
  const group = new THREE.Group();
  group.name = "upper-air-story-static";
  group.frustumCulled = false;
  group.renderOrder = 80;

  const pathLift = radius * 0.0031;
  const markerLift = radius * 0.0044;
  const markerObjectsByHourKey = new Map<string, THREE.Object3D[]>();

  const pathPieces = splitPolyline(
    points.map((p) => [p.longitude, p.latitude] as [number, number]),
    4.0
  );
  const pathMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(0xf3eee5),
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    depthTest: true,
  });
  for (const piece of pathPieces) {
    group.add(makeLine(piece, radius, pathLift, pathMat));
  }

  const dots6h = points.filter((p) => p.step_hour % 6 === 0);
  group.add(makePathDots(dots6h, radius, pathLift + radius * 0.0002, 0xf7f3ec, 1.7));

  const markerGeom = new THREE.SphereGeometry(radius * 0.0066, 14, 14);
  const markerMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0x6bd7ff),
    transparent: true,
    opacity: 0.97,
    depthWrite: false,
    depthTest: true,
  });

  for (const point of points) {
    const marker = new THREE.Mesh(markerGeom.clone(), markerMat.clone());
    marker.position.copy(
      latLonToVec3(point.latitude, point.longitude, radius + markerLift)
    );
    marker.visible = false;
    marker.frustumCulled = false;
    marker.renderOrder = 92;
    group.add(marker);
    markerObjectsByHourKey.set(point.hour_key, [marker]);
  }

  return { group, markerObjectsByHourKey };
}

function buildLocalContourContext(
  contourFile: MslContoursFile | null,
  centerLat: number,
  centerLon: number,
  radius: number,
  lift: number,
  baseColorHex: number,
  highlightColorHex: number,
  targetFeature: UpperAirSupportFeaturePoint | null,
  levelWindow: number,
  renderOrder: number,
  halfSpanLat = CONTOUR_HALF_SPAN_LAT,
  halfSpanLon = CONTOUR_HALF_SPAN_LON
) {
  if (!contourFile) return null;

  const group = new THREE.Group();
  group.frustumCulled = false;
  group.renderOrder = renderOrder;

  let bestPiece: Array<[number, number]> | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  const targetValue = targetFeature?.value ?? Number.NaN;

  const baseMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(baseColorHex),
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
    depthTest: true,
  });

  for (const [levelKey, lines] of Object.entries(contourFile.levels ?? {})) {
    const level = Number(levelKey);
    if (
      Number.isFinite(targetValue) &&
      Number.isFinite(level) &&
      Math.abs(level - targetValue) > levelWindow
    ) {
      continue;
    }

    for (const line of lines ?? []) {
      const pieces = clipPolylineToBox(
        line as Array<[number, number]>,
        centerLat,
        centerLon,
        halfSpanLat,
        halfSpanLon
      );
      for (const piece of pieces) {
        const splitPieces = splitPolyline(piece, 3.5);
        for (const splitPiece of splitPieces) {
          if (splitPiece.length < 2) continue;
          group.add(makeLine(splitPiece, radius, lift, baseMat.clone()));
          const dist = polylineDistanceToFeature(splitPiece, targetFeature);
          if (dist < bestDist) {
            bestDist = dist;
            bestPiece = splitPiece;
          }
        }
      }
    }
  }

  if (bestPiece) {
    const highlightMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(highlightColorHex),
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      depthTest: true,
    });
    const highlight = makeLine(bestPiece, radius, lift + 0.05, highlightMat);
    highlight.renderOrder = renderOrder + 1;
    highlight.userData.__pulseOpacity = {
      min: 0.4,
      max: 1,
      speed: 1.1,
      phase: 0.2,
    };
    group.add(highlight);
  }

  return group;
}

function computeContourMinMax(
  file: MslContoursFile,
  pressure: "250" | "925"
) {
  const fallback =
    pressure === "250" ? { min: 9600, max: 11200 } : { min: 500, max: 1100 };

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const key of Object.keys(file.levels ?? {})) {
    const value = Number(key);
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return fallback;
  return { min, max };
}

function gphToExtremaColor(levelM: number, minM: number, maxM: number) {
  const t = clamp01((levelM - minM) / Math.max(maxM - minM, 1e-6));
  const blue = new THREE.Color(0x205cff);
  const neutral = new THREE.Color(0x8b8b8b);
  const red = new THREE.Color(0xff4a3a);
  if (t <= 0.5) return blue.clone().lerp(neutral, t * 2.0);
  return neutral.clone().lerp(red, (t - 0.5) * 2.0);
}

function levelToContourColor(
  levelM: number,
  minM: number,
  maxM: number,
  contrast = 2.0
) {
  let t = clamp01((levelM - minM) / Math.max(maxM - minM, 1e-6));
  const width = 0.5 / Math.max(contrast, 1e-6);
  t = THREE.MathUtils.smoothstep(t, 0.5 - width, 0.5 + width);
  const green = new THREE.Color(0.0, 1.0, 0.15);
  const red = new THREE.Color(1.0, 0.0, 0.35);
  return green.clone().lerp(red, t);
}

function buildLowerContourSnippets(
  contourFile: MslContoursFile | null,
  centerLat: number,
  centerLon: number,
  radius: number,
  lift: number,
  halfSpanLat: number,
  halfSpanLon: number,
  renderOrder: number
) {
  if (!contourFile) return null;

  const group = new THREE.Group();
  group.name = "upper-air-lower-contour-snippets";
  group.frustumCulled = false;
  group.renderOrder = renderOrder;

  const { min, max } = computeContourMinMax(contourFile, "925");
  const levelKeys = Object.keys(contourFile.levels ?? {}).sort(
    (a, b) => Number(a) - Number(b)
  );

  for (const levelKey of levelKeys) {
    const level = Number(levelKey);
    if (!Number.isFinite(level)) continue;
    const color = gphToExtremaColor(level, min, max);
    const lines = contourFile.levels[levelKey] ?? [];

    for (const line of lines) {
      const pieces = clipPolylineToBox(
        line as Array<[number, number]>,
        centerLat,
        centerLon,
        halfSpanLat,
        halfSpanLon
      );
      for (const piece of pieces) {
        for (const splitPiece of splitPolyline(piece, 2.5)) {
          if (splitPiece.length < 2) continue;
          const contourLine = makeLine(
            splitPiece,
            radius,
            lift,
            new THREE.LineBasicMaterial({
              color,
              transparent: true,
              opacity: 0.82,
              depthWrite: false,
              depthTest: true,
            })
          );
          contourLine.renderOrder = renderOrder;
          group.add(contourLine);
        }
      }
    }
  }

  return group;
}

function buildUpperContourOverlay(
  contourFile: MslContoursFile | null,
  radius: number,
  lift: number,
  renderOrder: number
) {
  if (!contourFile) return null;

  const group = new THREE.Group();
  group.name = "upper-air-upper-contours";
  group.frustumCulled = false;
  group.renderOrder = renderOrder;

  const { min, max } = computeContourMinMax(contourFile, "250");
  const levelKeys = Object.keys(contourFile.levels ?? {}).sort(
    (a, b) => Number(a) - Number(b)
  );

  for (const levelKey of levelKeys) {
    const level = Number(levelKey);
    if (!Number.isFinite(level)) continue;
    const color = levelToContourColor(level, min, max, 2.0);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: true,
    });

    for (const line of contourFile.levels[levelKey] ?? []) {
      if (!line || line.length < 2) continue;
      const contourLine = makeLine(
        line as Array<[number, number]>,
        radius,
        lift,
        material.clone()
      );
      contourLine.renderOrder = renderOrder;
      group.add(contourLine);
    }
  }

  return group;
}

function buildPvFieldMesh(
  texture: THREE.Texture | null,
  radius: number,
  lift: number,
  renderOrder: number
) {
  if (!texture) return null;

  const geom = new THREE.SphereGeometry(radius + lift, 128, 128);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      uTex: { value: texture },
      uLonOffset: { value: 0.25 },
      uDataMin: { value: -2e-6 },
      uDataMax: { value: 2.4e-5 },
      uDisplayMin: { value: -2e-6 },
      uDisplayMax: { value: 2.4e-5 },
      uGamma: { value: 0.9 },
      uAlpha: { value: 0.72 },
      uLayerOpacity: { value: 1.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
uniform sampler2D uTex;
uniform float uLonOffset;
uniform float uDataMin;
uniform float uDataMax;
uniform float uDisplayMin;
uniform float uDisplayMax;
uniform float uGamma;
uniform float uAlpha;
uniform float uLayerOpacity;
varying vec2 vUv;

vec3 palette(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.07, 0.17, 0.48);
  vec3 c1 = vec3(0.17, 0.52, 0.85);
  vec3 c2 = vec3(0.95, 0.95, 0.92);
  vec3 c3 = vec3(0.86, 0.43, 0.18);
  vec3 c4 = vec3(0.58, 0.13, 0.08);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}

void main() {
  vec2 uv = vUv;
  uv.x = fract(uv.x + uLonOffset);
  float x = texture2D(uTex, uv).r;
  float pv = mix(uDataMin, uDataMax, x);
  float denom = max(uDisplayMax - uDisplayMin, 1e-12);
  float t = clamp((pv - uDisplayMin) / denom, 0.0, 1.0);
  t = pow(t, uGamma);
  vec3 col = palette(t);
  float alpha = smoothstep(0.02, 0.35, t) * clamp(uAlpha, 0.0, 1.0);
  alpha *= clamp(uLayerOpacity, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
    `,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  return mesh;
}

function buildPvDriverLayer(
  frame: UpperAirSupportFrame,
  contours: StoryContourData | null,
  manifest: UpperAirSupportManifest,
  style: UpperAirSupportStyleState,
  radius: number
) {
  const group = new THREE.Group();
  group.name = "upper-air-pv-driver";

  addIfPresent(
    group,
    buildLocalContourContext(
      contours?.upper250 ?? null,
      frame.latitude,
      frame.longitude,
      radius,
      radius * 0.0048,
      0xa17d4e,
      0xffe1a6,
      frame.features.trough250_min,
      260,
      72
    )
  );

  const pvRef = Math.max(
    manifest.summary.pv_p95_pvu ?? manifest.summary.pv_max_pvu ?? 1,
    1
  );
  const pvScale = 0.011 + 0.007 * clamp01((frame.features.pv250_peak?.value ?? 0) / pvRef);
  addIfPresent(
    group,
    makePulseRing(
      frame.features.pv250_peak,
      radius,
      radius * 0.0056,
      0xff58f4,
      pvScale,
      92,
      0.1
    )
  );
  addIfPresent(
    group,
    makeSwirlMarker(
      frame.features.pv250_peak,
      radius,
      radius * 0.0057,
      0xff7dff,
      93,
      0.3
    )
  );
  addIfPresent(
    group,
    makePulseRing(
      frame.features.ascent500_peak,
      radius,
      radius * 0.0040,
      0xff9b5b,
      0.009,
      91,
      0.5
    )
  );
  addIfPresent(
    group,
    makeFlowDotsConnector(
      frame.features.pv250_peak,
      radius * 0.0056,
      frame.features.ascent500_peak,
      radius * 0.0040,
      radius,
      0xffd8a3,
      0.0018,
      91,
      0.15
    )
  );
  addIfPresent(
    group,
    makeFeatureMarker(frame.features.pv250_peak, radius, radius * 0.0056, 0xff6fff, 0.0048, 94)
  );

  return group;
}

function buildStackedStructureLayer(
  frame: UpperAirSupportFrame,
  contours: StoryContourData | null,
  manifest: UpperAirSupportManifest,
  style: UpperAirSupportStyleState,
  pvTexture250: THREE.Texture | null,
  radius: number
) {
  const group = new THREE.Group();
  group.name = "upper-air-stacked-structure";

  const lowerLift = radius * 0.00255;
  const pvLift = radius * 0.00555;
  const upperContourLift = radius * 0.00635;

  addIfPresent(
    group,
    buildLowerContourSnippets(
      contours?.lower925 ?? null,
      frame.latitude,
      frame.longitude,
      radius,
      lowerLift,
      68,
      5.5,
      8.0
    )
  );

  addIfPresent(
    group,
    buildVerticalVelocityLayer(frame, manifest, style, radius)
  );

  addIfPresent(group, buildPvFieldMesh(pvTexture250, radius, pvLift, 74));

  addIfPresent(
    group,
    buildUpperContourOverlay(
      contours?.upper250 ?? null,
      radius,
      upperContourLift,
      82
    )
  );

  addIfPresent(group, makeFeatureMarker(frame.features.low925_min, radius, lowerLift + radius * 0.00012, 0x8ef6ff, 0.0044, 90));
  addIfPresent(group, makeFeatureMarker(frame.features.trough250_min, radius, upperContourLift + radius * 0.00012, 0xffd895, 0.0042, 91));

  return group;
}

function buildTiltLinkLayer(
  frame: UpperAirSupportFrame,
  contours: StoryContourData | null,
  radius: number
) {
  const group = new THREE.Group();
  group.name = "upper-air-tilt-link";

  addIfPresent(
    group,
    buildLocalContourContext(
      contours?.upper250 ?? null,
      frame.latitude,
      frame.longitude,
      radius,
      radius * 0.0047,
      0xd5a96d,
      0xffe2ad,
      frame.features.trough250_min,
      260,
      72
    )
  );
  addIfPresent(
    group,
    buildLocalContourContext(
      contours?.lower925 ?? null,
      frame.latitude,
      frame.longitude,
      radius,
      radius * 0.0030,
      0x67d8ff,
      0xcff7ff,
      frame.features.low925_min,
      120,
      70
    )
  );
  addIfPresent(
    group,
    makeFeatureConnector(
      frame.features.trough250_min,
      radius * 0.0047,
      frame.features.low925_min,
      radius * 0.0030,
      radius,
      0xeaf4ff,
      0.8,
      91
    )
  );
  addIfPresent(
    group,
    makeFeatureMarker(frame.features.trough250_min, radius, radius * 0.0049, 0xffd895, 0.0048, 93)
  );
  addIfPresent(
    group,
    makeFeatureMarker(frame.features.low925_min, radius, radius * 0.0031, 0x7af0ff, 0.0052, 93)
  );

  return group;
}

function buildLiftChainLayer(
  frame: UpperAirSupportFrame,
  style: UpperAirSupportStyleState,
  radius: number
) {
  const group = new THREE.Group();
  group.name = "upper-air-lift-chain";

  addIfPresent(
    group,
    makeRadialArrowGlyph(
      frame.features.divergence250_peak,
      radius,
      radius * 0.0053,
      0xffd477,
      false,
      style,
      90,
      0.1
    )
  );
  addIfPresent(
    group,
    makeRadialArrowGlyph(
      frame.features.convergence925_peak,
      radius,
      radius * 0.0030,
      0x66f0da,
      true,
      style,
      89,
      0.55
    )
  );
  addIfPresent(
    group,
    makePulseRing(
      frame.features.ascent500_peak,
      radius,
      radius * 0.0041,
      0xff8d52,
      0.0105,
      91,
      0.3
    )
  );
  addIfPresent(
    group,
    makeFeatureConnector(
      frame.features.convergence925_peak,
      radius * 0.0030,
      frame.features.ascent500_peak,
      radius * 0.0041,
      radius,
      0xffd4bd,
      0.35,
      88
    )
  );
  addIfPresent(
    group,
    makeFeatureConnector(
      frame.features.ascent500_peak,
      radius * 0.0041,
      frame.features.divergence250_peak,
      radius * 0.0053,
      radius,
      0xffe6b0,
      0.35,
      88
    )
  );
  addIfPresent(
    group,
    makeFlowDotsConnector(
      frame.features.convergence925_peak,
      radius * 0.0030,
      frame.features.ascent500_peak,
      radius * 0.0041,
      radius,
      0xffb28d,
      0.00175,
      92,
      0.0
    )
  );
  addIfPresent(
    group,
    makeFlowDotsConnector(
      frame.features.ascent500_peak,
      radius * 0.0041,
      frame.features.divergence250_peak,
      radius * 0.0053,
      radius,
      0xffdf9b,
      0.00175,
      92,
      0.48
    )
  );

  return group;
}

function buildFrameVisual(
  frame: UpperAirSupportFrame,
  contours: StoryContourData | null,
  pvTexture250: THREE.Texture | null,
  manifest: UpperAirSupportManifest,
  style: UpperAirSupportStyleState,
  radius: number
): FrameVisual {
  const group = new THREE.Group();
  group.name = `upper-air-story-frame-${frame.hour_key}`;
  group.frustumCulled = false;
  group.visible = false;
  group.renderOrder = 78;

  const verticalVelocity = buildVerticalVelocityLayer(frame, manifest, style, radius);
  const stackedStructure = buildStackedStructureLayer(
    frame,
    contours,
    manifest,
    style,
    pvTexture250,
    radius
  );
  const pvDriver = buildPvDriverLayer(frame, contours, manifest, style, radius);
  const tiltLink = buildTiltLinkLayer(frame, contours, radius);
  const liftChain = buildLiftChainLayer(frame, style, radius);

  if (verticalVelocity) group.add(verticalVelocity);
  if (stackedStructure) group.add(stackedStructure);
  group.add(pvDriver, tiltLink, liftChain);
  return {
    group,
    layers: {
      verticalVelocity: verticalVelocity ?? undefined,
      stackedStructure: stackedStructure ?? undefined,
      pvDriver,
      tiltLink,
      liftChain,
    },
  };
}

function applyStoryLayerVisibility(
  visual: FrameVisual,
  storyLayers: StoryLayerState
) {
  for (const key of STORY_LAYER_KEYS) {
    const layer = visual.layers[key];
    if (layer) layer.visible = storyLayers[key];
  }
}

function setActiveObjects(
  enabled: boolean,
  timestamp: string,
  objectsByHourKey: Map<string, THREE.Object3D[]>,
  activeObjectsRef: { current: THREE.Object3D[] }
) {
  for (const obj of activeObjectsRef.current) obj.visible = false;
  activeObjectsRef.current = [];

  if (!enabled) return;

  const next = objectsByHourKey.get(toHourlyKey(timestamp));
  if (!next || next.length === 0) return;

  for (const obj of next) obj.visible = true;
  activeObjectsRef.current = next;
}

function animateStoryObject(root: THREE.Object3D, timeSec: number) {
  root.traverse((obj) => {
    const spin = obj.userData.__spinZ as
      | { speed: number; phase?: number }
      | undefined;
    if (spin) {
      obj.rotation.z = (spin.phase ?? 0) + timeSec * spin.speed;
    }

    const pulseScale = obj.userData.__pulseScale as
      | { baseScale: number; amplitude: number; speed: number; phase?: number }
      | undefined;
    if (pulseScale) {
      const wave =
        0.5 + 0.5 * Math.sin(timeSec * pulseScale.speed + (pulseScale.phase ?? 0));
      const scale = pulseScale.baseScale * (1 + pulseScale.amplitude * wave);
      obj.scale.setScalar(scale);
    }

    const pulseOpacity = obj.userData.__pulseOpacity as
      | { min: number; max: number; speed: number; phase?: number }
      | undefined;
    if (pulseOpacity) {
      const wave =
        0.5 + 0.5 * Math.sin(timeSec * pulseOpacity.speed + (pulseOpacity.phase ?? 0));
      const opacity = THREE.MathUtils.lerp(pulseOpacity.min, pulseOpacity.max, wave);
      setMaterialOpacity(
        (obj as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material,
        opacity
      );
      for (const child of obj.children) {
        setMaterialOpacity(
          (child as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material,
          opacity
        );
      }
    }

    const flowDots = obj.userData.__flowDots as
      | {
          speed: number;
          width: number;
          phase?: number;
          minOpacity: number;
          maxOpacity: number;
        }
      | undefined;
    if (flowDots) {
      const head = ((timeSec * flowDots.speed + (flowDots.phase ?? 0)) % 1 + 1) % 1;
      for (const child of obj.children) {
        const t = Number((child as THREE.Object3D & { userData: Record<string, unknown> }).userData.__flowT);
        if (!Number.isFinite(t)) continue;
        const wrapped = Math.min(Math.abs(t - head), 1 - Math.abs(t - head));
        const strength = clamp01(1 - wrapped / Math.max(flowDots.width, 1e-6));
        const shaped = strength * strength;
        const opacity = THREE.MathUtils.lerp(flowDots.minOpacity, flowDots.maxOpacity, shaped);
        setMaterialOpacity(
          (child as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material,
          opacity
        );
        const scale = 0.75 + 0.85 * shaped;
        child.scale.setScalar(scale);
      }
    }
  });
}

export default function UpperAirSupportLayer() {
  const upperAirVerticalVelocity = useControls((s) => s.layers.upperAirVerticalVelocity);
  const upperAirStackedStructure = useControls((s) => s.layers.upperAirStackedStructure);
  const upperAirPvDriver = useControls((s) => s.layers.upperAirPvDriver);
  const upperAirTiltLink = useControls((s) => s.layers.upperAirTiltLink);
  const upperAirLiftChain = useControls((s) => s.layers.upperAirLiftChain);
  const upperAirSupport = useControls((s) => s.upperAirSupport);
  const {
    engineReady,
    sceneRef,
    timestamp,
    signalReady,
    registerFramePass,
    unregisterFramePass,
  } = useEarthLayer("upper-air-support");

  const storyLayers = useMemo<StoryLayerState>(
    () => ({
      verticalVelocity: upperAirVerticalVelocity,
      stackedStructure: upperAirStackedStructure,
      pvDriver: upperAirPvDriver,
      tiltLink: upperAirTiltLink,
      liftChain: upperAirLiftChain,
    }),
    [
      upperAirVerticalVelocity,
      upperAirStackedStructure,
      upperAirPvDriver,
      upperAirTiltLink,
      upperAirLiftChain,
    ]
  );
  const enabled =
    upperAirVerticalVelocity ||
    upperAirStackedStructure ||
    upperAirPvDriver ||
    upperAirTiltLink ||
    upperAirLiftChain;
  const needsContourContext = upperAirStackedStructure || upperAirPvDriver || upperAirTiltLink;
  const needsPvTexture = upperAirStackedStructure;

  const style = useMemo<UpperAirSupportStyleState>(
    () => ({
      ascentThreshold: upperAirSupport.ascentThreshold,
      ascentOpacity: upperAirSupport.ascentOpacity,
      ascentGamma: upperAirSupport.ascentGamma,
      divergenceThreshold: upperAirSupport.divergenceThreshold,
      arrowScale: upperAirSupport.arrowScale,
      arrowOpacity: upperAirSupport.arrowOpacity,
    }),
    [
      upperAirSupport.ascentThreshold,
      upperAirSupport.ascentOpacity,
      upperAirSupport.ascentGamma,
      upperAirSupport.divergenceThreshold,
      upperAirSupport.arrowScale,
      upperAirSupport.arrowOpacity,
    ]
  );

  const [manifest, setManifest] = useState<UpperAirSupportManifest | null>(null);
  const [manifestFailed, setManifestFailed] = useState(false);
  const [cacheVersion, setCacheVersion] = useState(0);

  const rootRef = useRef<THREE.Group | null>(null);
  const staticGroupRef = useRef<THREE.Group | null>(null);
  const latestTimestampRef = useRef(timestamp);
  const manifestLoadingRef = useRef(false);

  const markerObjectsByHourKeyRef = useRef<Map<string, THREE.Object3D[]>>(new Map());
  const activeMarkerObjectsRef = useRef<THREE.Object3D[]>([]);

  const frameDataCacheRef = useRef<Map<string, FrameDataEntry>>(new Map());
  const contourDataCacheRef = useRef<Map<string, ContourDataEntry>>(new Map());
  const pvTextureCacheRef = useRef<Map<string, PvTextureEntry>>(new Map());
  const frameVisualsByHourKeyRef = useRef<Map<string, FrameVisual>>(new Map());
  const activeFrameKeyRef = useRef<string | null>(null);

  const orderedHourKeys = useMemo(
    () =>
      manifest
        ? [...manifest.points]
            .map((point) => point.hour_key)
            .sort((a, b) => a.localeCompare(b))
        : [],
    [manifest]
  );

  const pointsByHourKey = useMemo(() => {
    if (!manifest) return new Map<string, UpperAirSupportPoint>();
    return new Map(manifest.points.map((point) => [point.hour_key, point]));
  }, [manifest]);

  const hideActiveFrame = useCallback(() => {
    const activeKey = activeFrameKeyRef.current;
    if (!activeKey) return;
    const activeVisual = frameVisualsByHourKeyRef.current.get(activeKey);
    if (activeVisual) activeVisual.group.visible = false;
    activeFrameKeyRef.current = null;
  }, []);

  const clearFrameVisuals = useCallback(() => {
    hideActiveFrame();
    for (const visual of frameVisualsByHourKeyRef.current.values()) {
      disposeObjectTree(visual.group);
      visual.group.removeFromParent();
    }
    frameVisualsByHourKeyRef.current.clear();
    setCacheVersion((v) => v + 1);
  }, [hideActiveFrame]);

  const showFrame = useCallback(
    (hourKey: string, visual: FrameVisual) => {
      const prevKey = activeFrameKeyRef.current;
      if (prevKey && prevKey !== hourKey) {
        const prevVisual = frameVisualsByHourKeyRef.current.get(prevKey);
        if (prevVisual) prevVisual.group.visible = false;
      }
      applyStoryLayerVisibility(visual, storyLayers);
      visual.group.visible = true;
      activeFrameKeyRef.current = hourKey;
    },
    [storyLayers]
  );

  useEffect(() => {
    latestTimestampRef.current = timestamp;
  }, [timestamp]);

  useEffect(() => {
    if (!engineReady || !sceneRef.current) return;

    const root = new THREE.Group();
    root.name = "upper-air-story-root";
    root.renderOrder = 78;
    root.visible = false;
    sceneRef.current.add(root);
    rootRef.current = root;

    return () => {
      setActiveObjects(
        false,
        latestTimestampRef.current,
        markerObjectsByHourKeyRef.current,
        activeMarkerObjectsRef
      );
      hideActiveFrame();

      for (const visual of frameVisualsByHourKeyRef.current.values()) {
        disposeObjectTree(visual.group);
        visual.group.removeFromParent();
      }
      frameVisualsByHourKeyRef.current.clear();
      frameDataCacheRef.current.clear();
      contourDataCacheRef.current.clear();
      for (const entry of pvTextureCacheRef.current.values()) {
        if (entry.status === "ready") entry.texture.dispose();
      }
      pvTextureCacheRef.current.clear();
      markerObjectsByHourKeyRef.current.clear();

      const staticGroup = staticGroupRef.current;
      if (staticGroup) {
        disposeObjectTree(staticGroup);
        staticGroup.removeFromParent();
        staticGroupRef.current = null;
      }

      root.removeFromParent();
      rootRef.current = null;
      manifestLoadingRef.current = false;
    };
  }, [engineReady, sceneRef, hideActiveFrame]);

  useEffect(() => {
    if (!engineReady) return;

    const passKey = "upper-air-story-animate";
    registerFramePass(passKey, (tick) => {
      const activeKey = activeFrameKeyRef.current;
      if (!enabled || !activeKey) return;
      const visual = frameVisualsByHourKeyRef.current.get(activeKey);
      if (!visual) return;
      animateStoryObject(visual.group, tick.t / 1000);
    });

    return () => {
      unregisterFramePass(passKey);
    };
  }, [engineReady, enabled, registerFramePass, unregisterFramePass]);

  useEffect(() => {
    if (!engineReady || !enabled || manifest || manifestFailed) return;
    if (manifestLoadingRef.current) return;

    let cancelled = false;
    manifestLoadingRef.current = true;

    void fetchUpperAirSupportManifest()
      .then((nextManifest) => {
        if (cancelled) return;
        setManifest(nextManifest);
        setManifestFailed(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setManifestFailed(true);
        console.error("Failed to load upper air support manifest", err);
        signalReady(latestTimestampRef.current);
      })
      .finally(() => {
        manifestLoadingRef.current = false;
      });

    return () => {
      cancelled = true;
      manifestLoadingRef.current = false;
    };
  }, [engineReady, enabled, manifest, manifestFailed, signalReady]);

  useEffect(() => {
    const root = rootRef.current;
    if (!engineReady || !root || !manifest) return;

    const built = buildStaticContext(manifest, 100);
    root.add(built.group);
    staticGroupRef.current = built.group;
    markerObjectsByHourKeyRef.current = built.markerObjectsByHourKey;

    return () => {
      setActiveObjects(
        false,
        latestTimestampRef.current,
        markerObjectsByHourKeyRef.current,
        activeMarkerObjectsRef
      );
      markerObjectsByHourKeyRef.current.clear();

      disposeObjectTree(built.group);
      built.group.removeFromParent();
      if (staticGroupRef.current === built.group) {
        staticGroupRef.current = null;
      }
    };
  }, [engineReady, manifest]);

  useEffect(() => {
    clearFrameVisuals();
  }, [style, needsContourContext, clearFrameVisuals]);

  useEffect(() => {
    for (const visual of frameVisualsByHourKeyRef.current.values()) {
      applyStoryLayerVisibility(visual, storyLayers);
    }
    const root = rootRef.current;
    if (root) root.visible = enabled;
  }, [storyLayers, enabled]);

  useEffect(() => {
    if (!engineReady) return;

    const root = rootRef.current;
    if (root) root.visible = enabled;

    setActiveObjects(
      enabled,
      timestamp,
      markerObjectsByHourKeyRef.current,
      activeMarkerObjectsRef
    );

    if (!enabled) {
      hideActiveFrame();
      signalReady(timestamp);
      return;
    }

    if (manifestFailed) {
      hideActiveFrame();
      signalReady(timestamp);
      return;
    }

    if (!manifest || !root) return;

    const currentHourKey = toHourlyKey(timestamp);
    const currentIndex = orderedHourKeys.indexOf(currentHourKey);
    if (currentIndex === -1) {
      hideActiveFrame();
      signalReady(timestamp);
      return;
    }

    const startIndex = Math.max(0, currentIndex - 1);
    const endIndex = Math.min(orderedHourKeys.length, currentIndex + 2);
    const desiredHourKeys = orderedHourKeys.slice(startIndex, endIndex);
    const desiredSet = new Set(desiredHourKeys);

    for (const desiredHourKey of desiredHourKeys) {
      const existing = frameDataCacheRef.current.get(desiredHourKey);
      if (existing?.status === "ready" || existing?.status === "loading") continue;
      if (!pointsByHourKey.has(desiredHourKey)) {
        frameDataCacheRef.current.set(desiredHourKey, { status: "missing" });
        continue;
      }

      const promise = (async () => {
        try {
          const frame = await fetchUpperAirSupportFrame(desiredHourKey);
          frameDataCacheRef.current.set(desiredHourKey, { status: "ready", frame });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes("(404")) {
            console.error(`Failed to load upper air support frame ${desiredHourKey}`, err);
          }
          frameDataCacheRef.current.set(desiredHourKey, {
            status: message.includes("(404") ? "missing" : "error",
          });
        } finally {
          setCacheVersion((v) => v + 1);
        }
      })();

      frameDataCacheRef.current.set(desiredHourKey, { status: "loading", promise });
    }

    if (needsContourContext) {
      for (const desiredHourKey of desiredHourKeys) {
        const existing = contourDataCacheRef.current.get(desiredHourKey);
        if (existing?.status === "ready" || existing?.status === "loading") continue;

        const promise = (async () => {
          try {
            const [upper250, lower925] = await Promise.all([
              fetchMslContours(desiredHourKey, "250"),
              fetchMslContours(desiredHourKey, "925"),
            ]);
            contourDataCacheRef.current.set(desiredHourKey, {
              status: "ready",
              data: { upper250, lower925 },
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!message.includes("(404")) {
              console.error(`Failed to load contour context ${desiredHourKey}`, err);
            }
            contourDataCacheRef.current.set(desiredHourKey, {
              status: message.includes("(404") ? "missing" : "error",
              data: null,
            });
          } finally {
            setCacheVersion((v) => v + 1);
          }
        })();

        contourDataCacheRef.current.set(desiredHourKey, { status: "loading", promise });
      }
    }

    if (needsPvTexture) {
      for (const desiredHourKey of desiredHourKeys) {
        const existing = pvTextureCacheRef.current.get(desiredHourKey);
        if (existing?.status === "ready" || existing?.status === "loading") continue;

        const promise = (async () => {
          try {
            const texture = await new Promise<THREE.Texture>((resolve, reject) => {
              new THREE.TextureLoader().load(
                potentialVorticityApiUrl(desiredHourKey, 250),
                resolve,
                undefined,
                reject
              );
            });
            configureDataTexture(texture);
            pvTextureCacheRef.current.set(desiredHourKey, {
              status: "ready",
              texture,
            });
          } catch (err) {
            console.error(`Failed to load 250 hPa PV texture ${desiredHourKey}`, err);
            pvTextureCacheRef.current.set(desiredHourKey, { status: "error" });
          } finally {
            setCacheVersion((v) => v + 1);
          }
        })();

        pvTextureCacheRef.current.set(desiredHourKey, { status: "loading", promise });
      }
    }

    const protectedKeys = new Set<string>();
    if (activeFrameKeyRef.current) protectedKeys.add(activeFrameKeyRef.current);

    for (const [hourKey, visual] of frameVisualsByHourKeyRef.current.entries()) {
      if (desiredSet.has(hourKey) || protectedKeys.has(hourKey)) continue;
      disposeObjectTree(visual.group);
      visual.group.removeFromParent();
      frameVisualsByHourKeyRef.current.delete(hourKey);
    }

    for (const [hourKey, entry] of frameDataCacheRef.current.entries()) {
      if (desiredSet.has(hourKey) || protectedKeys.has(hourKey)) continue;
      if (entry.status === "loading") continue;
      frameDataCacheRef.current.delete(hourKey);
    }

    for (const [hourKey, entry] of contourDataCacheRef.current.entries()) {
      if (desiredSet.has(hourKey) || protectedKeys.has(hourKey)) continue;
      if (entry.status === "loading") continue;
      contourDataCacheRef.current.delete(hourKey);
    }

    for (const [hourKey, entry] of pvTextureCacheRef.current.entries()) {
      if (desiredSet.has(hourKey) || protectedKeys.has(hourKey)) continue;
      if (entry.status === "loading") continue;
      if (entry.status === "ready") entry.texture.dispose();
      pvTextureCacheRef.current.delete(hourKey);
    }

    const currentEntry = frameDataCacheRef.current.get(currentHourKey);
    if (currentEntry?.status === "ready") {
      const contourEntry = contourDataCacheRef.current.get(currentHourKey);
      if (needsContourContext && contourEntry?.status === "loading") {
        return;
      }
      const pvTextureEntry = pvTextureCacheRef.current.get(currentHourKey);
      if (needsPvTexture && pvTextureEntry?.status === "loading") {
        return;
      }

      let visual = frameVisualsByHourKeyRef.current.get(currentHourKey);
      if (!visual) {
        const contourData =
          contourEntry?.status === "ready" ? contourEntry.data : null;
        const pvTexture250 =
          pvTextureEntry?.status === "ready" ? pvTextureEntry.texture : null;
        visual = buildFrameVisual(
          currentEntry.frame,
          contourData,
          pvTexture250,
          manifest,
          style,
          100
        );
        frameVisualsByHourKeyRef.current.set(currentHourKey, visual);
        root.add(visual.group);
      }
      showFrame(currentHourKey, visual);
      signalReady(timestamp);
      return;
    }

    if (currentEntry?.status === "missing" || currentEntry?.status === "error") {
      hideActiveFrame();
      signalReady(timestamp);
      return;
    }
  }, [
    engineReady,
    enabled,
    timestamp,
    manifest,
    orderedHourKeys,
    pointsByHourKey,
    manifestFailed,
    needsContourContext,
    needsPvTexture,
    cacheVersion,
    style,
    storyLayers,
    hideActiveFrame,
    showFrame,
    signalReady,
  ]);

  return null;
}
