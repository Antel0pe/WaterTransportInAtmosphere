"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useEarthLayer } from "./EarthBase";
import {
  fetchMslContours,
  fetchUpperAirSupportFrame,
  fetchUpperAirSupportManifest,
  type MslContoursFile,
  type UpperAirSupportFeaturePoint,
  type UpperAirSupportFrame,
  type UpperAirSupportManifest,
  type UpperAirSupportPoint,
} from "../utils/ApiResponses";
import { latLonToVec3 } from "../utils/EarthUtils";
import { useControls } from "../../state/controlsStore";

type StoryLayerKey = "pvDriver" | "tiltLink" | "liftChain";

type StoryLayerState = Record<StoryLayerKey, boolean>;

type UpperAirSupportStyleState = {
  ascentOpacity: number;
  arrowScale: number;
  arrowOpacity: number;
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

const STORY_LAYER_KEYS: StoryLayerKey[] = ["pvDriver", "tiltLink", "liftChain"];
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
  renderOrder: number
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
        CONTOUR_HALF_SPAN_LAT,
        CONTOUR_HALF_SPAN_LON
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
  manifest: UpperAirSupportManifest,
  style: UpperAirSupportStyleState,
  radius: number
): FrameVisual {
  const group = new THREE.Group();
  group.name = `upper-air-story-frame-${frame.hour_key}`;
  group.frustumCulled = false;
  group.visible = false;
  group.renderOrder = 78;

  const pvDriver = buildPvDriverLayer(frame, contours, manifest, style, radius);
  const tiltLink = buildTiltLinkLayer(frame, contours, radius);
  const liftChain = buildLiftChainLayer(frame, style, radius);

  group.add(pvDriver, tiltLink, liftChain);
  return {
    group,
    layers: {
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
      pvDriver: upperAirPvDriver,
      tiltLink: upperAirTiltLink,
      liftChain: upperAirLiftChain,
    }),
    [upperAirPvDriver, upperAirTiltLink, upperAirLiftChain]
  );
  const enabled = upperAirPvDriver || upperAirTiltLink || upperAirLiftChain;
  const needsContourContext = upperAirPvDriver || upperAirTiltLink;

  const style = useMemo<UpperAirSupportStyleState>(
    () => ({
      ascentOpacity: upperAirSupport.ascentOpacity,
      arrowScale: upperAirSupport.arrowScale,
      arrowOpacity: upperAirSupport.arrowOpacity,
    }),
    [upperAirSupport.ascentOpacity, upperAirSupport.arrowScale, upperAirSupport.arrowOpacity]
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

    const currentEntry = frameDataCacheRef.current.get(currentHourKey);
    if (currentEntry?.status === "ready") {
      const contourEntry = contourDataCacheRef.current.get(currentHourKey);
      if (needsContourContext && contourEntry?.status === "loading") {
        return;
      }

      let visual = frameVisualsByHourKeyRef.current.get(currentHourKey);
      if (!visual) {
        const contourData =
          contourEntry?.status === "ready" ? contourEntry.data : null;
        visual = buildFrameVisual(currentEntry.frame, contourData, manifest, style, 100);
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
    cacheVersion,
    style,
    storyLayers,
    hideActiveFrame,
    showFrame,
    signalReady,
  ]);

  return null;
}
