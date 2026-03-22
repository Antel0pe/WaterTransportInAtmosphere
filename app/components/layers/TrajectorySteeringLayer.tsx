"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import {
  fetchTrajectorySteering,
  type TrajectorySteeringFile,
  type TrajectorySteeringFrame,
  type TrajectorySteeringPoint,
  type TrajectorySteeringSample,
} from "../utils/ApiResponses";
import { latLonToVec3 } from "../utils/EarthUtils";
import { useControls } from "../../state/controlsStore";

type TrajectorySteeringStyleState = {
  contourOpacity: boolean;
  contourGradientRibbon: boolean;
  contourPulse: boolean;
};

type FrameGrid = {
  lats: number[];
  lons: number[];
  nLat: number;
  nLon: number;
  samples: Array<Array<TrajectorySteeringSample | undefined>>;
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
};

type ContourVisual = {
  strength: number;
  baseColor: THREE.Color;
  baseLine: THREE.Line;
  baseMaterial: THREE.LineBasicMaterial;
};

type SteeringBuildResult = {
  group: THREE.Group;
  fieldObjectsByHourKey: Map<string, THREE.Object3D[]>;
  contourObjectsByHourKey: Map<string, THREE.Object3D[]>;
  markerObjectsByHourKey: Map<string, THREE.Object3D[]>;
  ribbonObjectsByHourKey: Map<string, THREE.Object3D[]>;
  pulseObjectsByHourKey: Map<string, THREE.Object3D[]>;
  contourVisualsByHourKey: Map<string, ContourVisual[]>;
};

function clamp01(x: number) {
  return THREE.MathUtils.clamp(x, 0, 1);
}

function smoothNorm(value: number, min: number, max: number) {
  const denom = Math.max(max - min, 1e-6);
  return clamp01((value - min) / denom);
}

function smoothstep(min: number, max: number, value: number) {
  return THREE.MathUtils.smoothstep(value, min, max);
}

function toHourlyKey(timestamp: string) {
  const trimmed = timestamp.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(trimmed);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:00`;

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

function sampleKey(lat: number, lon: number) {
  return `${lat.toFixed(4)}|${lon.toFixed(4)}`;
}

function percentile(values: number[], q: number, fallback: number) {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return fallback;
  const idx = (finite.length - 1) * (q / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const t = idx - lo;
  if (lo === hi) return finite[lo];
  return finite[lo] * (1 - t) + finite[hi] * t;
}

function colorForSample(
  sample: TrajectorySteeringSample | undefined,
  thetaeCenter: number,
  thetaeHalfRange: number,
  warm: THREE.Color,
  neutral: THREE.Color,
  cold: THREE.Color
) {
  if (!sample) return neutral.clone();

  const signed = THREE.MathUtils.clamp(
    (sample.thetae_k - thetaeCenter) / thetaeHalfRange,
    -1,
    1
  );
  const endpoint = signed >= 0 ? warm : cold;
  const magnitude = Math.abs(signed);
  const neutralBand = 0.03;
  if (magnitude <= neutralBand) return neutral.clone();

  const t = smoothNorm(magnitude, neutralBand, 1);
  const hueStrength = 0.14 + 0.86 * Math.pow(t, 0.65);
  return neutral.clone().lerp(endpoint, hueStrength);
}

function gphContourColor(levelM: number, minM: number, maxM: number) {
  const t = smoothNorm(levelM, minM, maxM);
  const cool = new THREE.Color(0x8fd7ff);
  const neutral = new THREE.Color(0xf4f0e8);
  const warm = new THREE.Color(0xffd38a);
  if (t <= 0.5) return cool.clone().lerp(neutral, t * 2.0);
  return neutral.clone().lerp(warm, (t - 0.5) * 2.0);
}

function nearestIndex(values: number[], target: number) {
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < values.length; i++) {
    const d = Math.abs(values[i] - target);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function buildFrameGrid(
  frame: TrajectorySteeringFrame,
  radius: number,
  lift: number
): FrameGrid | null {
  const lats = frame.grid_latitudes ?? [];
  const lons = frame.grid_longitudes ?? [];
  const nLat = lats.length;
  const nLon = lons.length;
  const count = nLat * nLon;
  if (nLat < 2 || nLon < 2 || count === 0) return null;

  const positions = new Float32Array(count * 3);
  const sampleMap = new Map<string, TrajectorySteeringSample>();
  for (const sample of frame.samples) {
    sampleMap.set(sampleKey(sample.latitude, sample.longitude), sample);
  }

  const samples: Array<Array<TrajectorySteeringSample | undefined>> = Array.from(
    { length: nLat },
    () => Array<TrajectorySteeringSample | undefined>(nLon)
  );

  let vertexIndex = 0;
  for (let latIdx = 0; latIdx < nLat; latIdx++) {
    for (let lonIdx = 0; lonIdx < nLon; lonIdx++) {
      const lat = lats[latIdx];
      const lon = lons[lonIdx];
      samples[latIdx][lonIdx] = sampleMap.get(sampleKey(lat, lon));

      const v = latLonToVec3(lat, lon, radius + lift);
      positions[vertexIndex * 3 + 0] = v.x;
      positions[vertexIndex * 3 + 1] = v.y;
      positions[vertexIndex * 3 + 2] = v.z;
      vertexIndex += 1;
    }
  }

  const triangleCount = (nLat - 1) * (nLon - 1) * 2;
  const indices = new (count > 65535 ? Uint32Array : Uint16Array)(triangleCount * 3);
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

function makeFieldMesh(
  frameGrid: FrameGrid,
  frame: TrajectorySteeringFrame,
  file: TrajectorySteeringFile
) {
  const count = frameGrid.nLat * frameGrid.nLon;
  const colors = new Float32Array(count * 3);
  const alphas = new Float32Array(count);

  const warm = new THREE.Color(0xff584e);
  const neutral = new THREE.Color(0xf7f1e6);
  const cold = new THREE.Color(0x356cff);

  const thetaeVals = frame.samples.map((s) => s.thetae_k);
  const thetaeP10 = percentile(
    thetaeVals,
    10,
    file.summary.thetae_p10_k ?? file.summary.thetae_min_k
  );
  const thetaeP90 = percentile(
    thetaeVals,
    90,
    file.summary.thetae_p90_k ?? file.summary.thetae_max_k
  );
  const thetaeCenter = 0.5 * (thetaeP10 + thetaeP90);
  const thetaeHalfRange = Math.max(0.5 * (thetaeP90 - thetaeP10), 1e-6);

  const windVals = frame.samples.map((s) => s.wind_speed_ms);
  const windP25 = percentile(windVals, 25, file.summary.wind_speed_p25_ms);
  const windP95 = Math.max(
    percentile(windVals, 95, file.summary.wind_speed_p95_ms),
    windP25 + 1e-6
  );

  let vertexIndex = 0;
  for (let latIdx = 0; latIdx < frameGrid.nLat; latIdx++) {
    for (let lonIdx = 0; lonIdx < frameGrid.nLon; lonIdx++) {
      const sample = frameGrid.samples[latIdx][lonIdx];
      const color = colorForSample(
        sample,
        thetaeCenter,
        thetaeHalfRange,
        warm,
        neutral,
        cold
      );
      colors[vertexIndex * 3 + 0] = color.r;
      colors[vertexIndex * 3 + 1] = color.g;
      colors[vertexIndex * 3 + 2] = color.b;

      const speedT = sample ? smoothstep(windP25, windP95, sample.wind_speed_ms) : 0;
      alphas[vertexIndex] = 0.35 + 0.6 * Math.pow(speedT, 0.7);
      vertexIndex += 1;
    }
  }

  return makeVertexAlphaMesh(frameGrid.positions, frameGrid.indices, colors, alphas, 70);
}

function makeGradientRibbonMesh(frameGrid: FrameGrid, file: TrajectorySteeringFile) {
  const count = frameGrid.nLat * frameGrid.nLon;
  const colors = new Float32Array(count * 3);
  const alphas = new Float32Array(count);
  const low = file.summary.gph_grad_p50_m_per_100km;
  const high = Math.max(file.summary.gph_grad_p95_m_per_100km, low + 1e-6);
  const ribbon = new THREE.Color(0xffe2a8);

  let vertexIndex = 0;
  for (let latIdx = 0; latIdx < frameGrid.nLat; latIdx++) {
    for (let lonIdx = 0; lonIdx < frameGrid.nLon; lonIdx++) {
      const sample = frameGrid.samples[latIdx][lonIdx];
      const strength = sample
        ? smoothstep(low, high, sample.gph_grad_m_per_100km)
        : 0;
      colors[vertexIndex * 3 + 0] = ribbon.r;
      colors[vertexIndex * 3 + 1] = ribbon.g;
      colors[vertexIndex * 3 + 2] = ribbon.b;
      alphas[vertexIndex] = 0.02 + 0.24 * Math.pow(strength, 1.35);
      vertexIndex += 1;
    }
  }

  return makeVertexAlphaMesh(frameGrid.positions, frameGrid.indices, colors, alphas, 74);
}

function makePulseMesh(frameGrid: FrameGrid, file: TrajectorySteeringFile) {
  const count = frameGrid.nLat * frameGrid.nLon;
  const colors = new Float32Array(count * 3);
  const alphas = new Float32Array(count);
  const low = file.summary.gph_grad_p50_m_per_100km;
  const high = Math.max(file.summary.gph_grad_p95_m_per_100km, low + 1e-6);
  const pulse = new THREE.Color(0xffe2a8);

  let vertexIndex = 0;
  for (let latIdx = 0; latIdx < frameGrid.nLat; latIdx++) {
    for (let lonIdx = 0; lonIdx < frameGrid.nLon; lonIdx++) {
      const sample = frameGrid.samples[latIdx][lonIdx];
      const strength = sample
        ? smoothstep(low, high, sample.gph_grad_m_per_100km)
        : 0;
      colors[vertexIndex * 3 + 0] = pulse.r;
      colors[vertexIndex * 3 + 1] = pulse.g;
      colors[vertexIndex * 3 + 2] = pulse.b;
      alphas[vertexIndex] = 0.015 + 0.34 * Math.pow(strength, 2.0);
      vertexIndex += 1;
    }
  }

  return makeVertexAlphaMesh(frameGrid.positions, frameGrid.indices, colors, alphas, 76);
}

function makePathDots(
  points: TrajectorySteeringPoint[],
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

function sampleFrameStrength(
  frameGrid: FrameGrid,
  lat: number,
  lon: number,
  file: TrajectorySteeringFile
) {
  const latIdx = nearestIndex(frameGrid.lats, lat);
  const lonIdx = nearestIndex(frameGrid.lons, lon);
  const sample = frameGrid.samples[latIdx][lonIdx];
  if (!sample) return 0;

  return smoothstep(
    file.summary.gph_grad_p50_m_per_100km,
    Math.max(file.summary.gph_grad_p95_m_per_100km, file.summary.gph_grad_p50_m_per_100km + 1e-6),
    sample.gph_grad_m_per_100km
  );
}

function contourStrengthForPiece(
  piece: Array<[number, number]>,
  frameGrid: FrameGrid,
  file: TrajectorySteeringFile
) {
  const strengths: number[] = [];
  const step = Math.max(1, Math.floor(piece.length / 8));
  for (let i = 0; i < piece.length; i += step) {
    const [lon, lat] = piece[i];
    strengths.push(sampleFrameStrength(frameGrid, lat, lon, file));
  }

  const [lastLon, lastLat] = piece[piece.length - 1];
  strengths.push(sampleFrameStrength(frameGrid, lastLat, lastLon, file));
  return percentile(strengths, 75, 0);
}

function applyContourStyleToVisual(
  visual: ContourVisual,
  style: TrajectorySteeringStyleState,
  _timeSec: number
) {
  let baseOpacity = 0.88;
  if (style.contourOpacity) {
    baseOpacity *= 0.28 + 0.72 * visual.strength;
  }

  visual.baseMaterial.color.copy(visual.baseColor);
  visual.baseMaterial.opacity = clamp01(baseOpacity);
  visual.baseMaterial.needsUpdate = true;
}

function updateActiveContourVisuals(
  visuals: ContourVisual[],
  style: TrajectorySteeringStyleState,
  timeSec: number
) {
  for (const visual of visuals) {
    applyContourStyleToVisual(visual, style, timeSec);
  }
}

function buildSteeringGroup(
  file: TrajectorySteeringFile,
  radius: number,
  _viewportSize: { width: number; height: number }
): SteeringBuildResult {
  const points = [...file.points].sort((a, b) => a.step_hour - b.step_hour);
  const group = new THREE.Group();
  group.name = "trajectory-steering-group";
  group.renderOrder = 64;
  group.frustumCulled = false;

  const fieldObjectsByHourKey = new Map<string, THREE.Object3D[]>();
  const contourObjectsByHourKey = new Map<string, THREE.Object3D[]>();
  const markerObjectsByHourKey = new Map<string, THREE.Object3D[]>();
  const ribbonObjectsByHourKey = new Map<string, THREE.Object3D[]>();
  const pulseObjectsByHourKey = new Map<string, THREE.Object3D[]>();
  const contourVisualsByHourKey = new Map<string, ContourVisual[]>();

  const pathLift = radius * 0.0032;
  const fieldLift = radius * 0.0028;
  const ribbonLift = radius * 0.00315;
  const contourLift = radius * 0.0036;
  const markerLift = radius * 0.0042;

  const pathPieces = splitPolyline(
    points.map((p) => [p.longitude, p.latitude] as [number, number]),
    4.0
  );
  const pathMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(0xece9e2),
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    depthTest: true,
  });
  for (const piece of pathPieces) {
    group.add(makeLine(piece, radius, pathLift, pathMat));
  }

  const dots6h = points.filter((p) => p.step_hour % 6 === 0);
  group.add(makePathDots(dots6h, radius, pathLift + radius * 0.0002, 0xf5f2ea, 1.7));

  const contourLevels = (file.metadata.contour_levels_m ?? [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  const contourMin = contourLevels.length > 0 ? Math.min(...contourLevels) : 0;
  const contourMax = contourLevels.length > 0 ? Math.max(...contourLevels) : 1;

  for (const frame of file.frames) {
    const hourKey = frame.hour_key ?? toHourlyKey(frame.valid_time);
    const frameGrid = buildFrameGrid(frame, radius, fieldLift);

    const frameFieldObjects: THREE.Object3D[] = [];
    const frameRibbonObjects: THREE.Object3D[] = [];
    const framePulseObjects: THREE.Object3D[] = [];

    if (frameGrid) {
      const fieldMesh = makeFieldMesh(frameGrid, frame, file);
      fieldMesh.visible = false;
      group.add(fieldMesh);
      frameFieldObjects.push(fieldMesh);

      const ribbonGrid = buildFrameGrid(frame, radius, ribbonLift);
      if (ribbonGrid) {
        const ribbonMesh = makeGradientRibbonMesh(ribbonGrid, file);
        ribbonMesh.visible = false;
        group.add(ribbonMesh);
        frameRibbonObjects.push(ribbonMesh);

        const pulseMesh = makePulseMesh(ribbonGrid, file);
        pulseMesh.visible = false;
        group.add(pulseMesh);
        framePulseObjects.push(pulseMesh);
      }
    }

    fieldObjectsByHourKey.set(hourKey, frameFieldObjects);
    ribbonObjectsByHourKey.set(hourKey, frameRibbonObjects);
    pulseObjectsByHourKey.set(hourKey, framePulseObjects);

    const contourObjects: THREE.Object3D[] = [];
    const contourVisuals: ContourVisual[] = [];

    for (const contour of frame.contours) {
      const baseColor = gphContourColor(contour.level_m, contourMin, contourMax);
      const pieces = splitPolyline(contour.points as Array<[number, number]>, 3.5);

      for (const piece of pieces) {
        const strength = frameGrid ? contourStrengthForPiece(piece, frameGrid, file) : 0;

        const baseMaterial = new THREE.LineBasicMaterial({
          color: baseColor,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          depthTest: true,
        });
        const baseLine = makeLine(piece, radius, contourLift, baseMaterial);
        baseLine.visible = false;
        baseLine.renderOrder = 90;
        group.add(baseLine);
        contourObjects.push(baseLine);

        contourVisuals.push({
          strength,
          baseColor: baseColor.clone(),
          baseLine,
          baseMaterial,
        });
      }
    }

    contourObjectsByHourKey.set(hourKey, contourObjects);
    contourVisualsByHourKey.set(hourKey, contourVisuals);

    const markerGeom = new THREE.SphereGeometry(radius * 0.0065, 14, 14);
    const markerMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xfff7ec),
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      depthTest: true,
    });
    const marker = new THREE.Mesh(markerGeom, markerMat);
    marker.position.copy(latLonToVec3(frame.latitude, frame.longitude, radius + markerLift));
    marker.visible = false;
    marker.frustumCulled = false;
    marker.renderOrder = 92;
    group.add(marker);
    markerObjectsByHourKey.set(hourKey, [marker]);
  }

  return {
    group,
    fieldObjectsByHourKey,
    contourObjectsByHourKey,
    markerObjectsByHourKey,
    ribbonObjectsByHourKey,
    pulseObjectsByHourKey,
    contourVisualsByHourKey,
  };
}

function setObjectAlphaMul(obj: THREE.Object3D, alphaMul: number) {
  if (!(obj instanceof THREE.Mesh)) return;
  const material = obj.material;
  if (!(material instanceof THREE.ShaderMaterial)) return;
  const uniform = material.uniforms?.uAlphaMul;
  if (!uniform) return;
  uniform.value = alphaMul;
}

function setPulseObjectsAlpha(objects: THREE.Object3D[], alphaMul: number) {
  for (const obj of objects) setObjectAlphaMul(obj, alphaMul);
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

function setActiveContourVisuals(
  enabled: boolean,
  timestamp: string,
  visualsByHourKey: Map<string, ContourVisual[]>,
  activeVisualsRef: { current: ContourVisual[] }
) {
  activeVisualsRef.current = enabled
    ? visualsByHourKey.get(toHourlyKey(timestamp)) ?? []
    : [];
}

export default function TrajectorySteeringLayer() {
  const enabled = useControls((s) => s.layers.trajectorySteering);
  const steeringStyle = useControls((s) => s.trajectorySteeringStyle);
  const {
    engineReady,
    sceneRef,
    globeRef,
    rendererRef,
    timestamp,
    signalReady,
    registerFramePass,
    unregisterFramePass,
  } = useEarthLayer("trajectory-steering");

  const style = useMemo<TrajectorySteeringStyleState>(
    () => ({ ...steeringStyle }),
    [steeringStyle]
  );

  const rootRef = useRef<THREE.Group | null>(null);
  const contentRef = useRef<THREE.Group | null>(null);
  const loadedRef = useRef(false);
  const failedRef = useRef(false);
  const latestTimestampRef = useRef(timestamp);
  const styleRef = useRef(style);

  const fieldObjectsByHourKeyRef = useRef<Map<string, THREE.Object3D[]>>(new Map());
  const contourObjectsByHourKeyRef = useRef<Map<string, THREE.Object3D[]>>(new Map());
  const markerObjectsByHourKeyRef = useRef<Map<string, THREE.Object3D[]>>(new Map());
  const ribbonObjectsByHourKeyRef = useRef<Map<string, THREE.Object3D[]>>(new Map());
  const pulseObjectsByHourKeyRef = useRef<Map<string, THREE.Object3D[]>>(new Map());
  const contourVisualsByHourKeyRef = useRef<Map<string, ContourVisual[]>>(new Map());

  const activeFieldObjectsRef = useRef<THREE.Object3D[]>([]);
  const activeContourObjectsRef = useRef<THREE.Object3D[]>([]);
  const activeMarkerObjectsRef = useRef<THREE.Object3D[]>([]);
  const activeRibbonObjectsRef = useRef<THREE.Object3D[]>([]);
  const activePulseObjectsRef = useRef<THREE.Object3D[]>([]);
  const activeContourVisualsRef = useRef<ContourVisual[]>([]);

  useEffect(() => {
    latestTimestampRef.current = timestamp;
  }, [timestamp]);

  useEffect(() => {
    styleRef.current = style;
  }, [style]);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const root = new THREE.Group();
    root.name = "trajectory-steering-root";
    root.renderOrder = 64;
    root.visible = false;
    sceneRef.current.add(root);
    rootRef.current = root;

    return () => {
      setActiveObjects(false, latestTimestampRef.current, fieldObjectsByHourKeyRef.current, activeFieldObjectsRef);
      setActiveObjects(false, latestTimestampRef.current, contourObjectsByHourKeyRef.current, activeContourObjectsRef);
      setActiveObjects(false, latestTimestampRef.current, markerObjectsByHourKeyRef.current, activeMarkerObjectsRef);
      setActiveObjects(false, latestTimestampRef.current, ribbonObjectsByHourKeyRef.current, activeRibbonObjectsRef);
      setActiveObjects(false, latestTimestampRef.current, pulseObjectsByHourKeyRef.current, activePulseObjectsRef);
      setActiveContourVisuals(false, latestTimestampRef.current, contourVisualsByHourKeyRef.current, activeContourVisualsRef);

      fieldObjectsByHourKeyRef.current.clear();
      contourObjectsByHourKeyRef.current.clear();
      markerObjectsByHourKeyRef.current.clear();
      ribbonObjectsByHourKeyRef.current.clear();
      pulseObjectsByHourKeyRef.current.clear();
      contourVisualsByHourKeyRef.current.clear();

      const content = contentRef.current;
      if (content) {
        disposeObjectTree(content);
        content.removeFromParent();
        contentRef.current = null;
      }

      root.removeFromParent();
      rootRef.current = null;
      loadedRef.current = false;
      failedRef.current = false;
    };
  }, [engineReady, sceneRef, globeRef]);

  useEffect(() => {
    if (!engineReady) return;
    if (!enabled) return;
    const root = rootRef.current;
    if (!root) return;
    if (loadedRef.current) {
      signalReady(latestTimestampRef.current);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const file = await fetchTrajectorySteering();
        if (cancelled) return;

        const size = new THREE.Vector2(1024, 768);
        rendererRef.current?.getSize(size);
        const built = buildSteeringGroup(file, 100, {
          width: size.x,
          height: size.y,
        });

        root.add(built.group);
        contentRef.current = built.group;
        fieldObjectsByHourKeyRef.current = built.fieldObjectsByHourKey;
        contourObjectsByHourKeyRef.current = built.contourObjectsByHourKey;
        markerObjectsByHourKeyRef.current = built.markerObjectsByHourKey;
        ribbonObjectsByHourKeyRef.current = built.ribbonObjectsByHourKey;
        pulseObjectsByHourKeyRef.current = built.pulseObjectsByHourKey;
        contourVisualsByHourKeyRef.current = built.contourVisualsByHourKey;

        setActiveObjects(enabled, latestTimestampRef.current, fieldObjectsByHourKeyRef.current, activeFieldObjectsRef);
        setActiveObjects(enabled, latestTimestampRef.current, contourObjectsByHourKeyRef.current, activeContourObjectsRef);
        setActiveObjects(enabled, latestTimestampRef.current, markerObjectsByHourKeyRef.current, activeMarkerObjectsRef);
        setActiveObjects(
          enabled && styleRef.current.contourGradientRibbon,
          latestTimestampRef.current,
          ribbonObjectsByHourKeyRef.current,
          activeRibbonObjectsRef
        );
        setActiveObjects(
          enabled && styleRef.current.contourPulse,
          latestTimestampRef.current,
          pulseObjectsByHourKeyRef.current,
          activePulseObjectsRef
        );
        setActiveContourVisuals(
          enabled,
          latestTimestampRef.current,
          contourVisualsByHourKeyRef.current,
          activeContourVisualsRef
        );
        updateActiveContourVisuals(
          activeContourVisualsRef.current,
          styleRef.current,
          performance.now() * 0.001
        );
        setPulseObjectsAlpha(activePulseObjectsRef.current, styleRef.current.contourPulse ? 0.9 : 1.0);

        loadedRef.current = true;
        failedRef.current = false;
        signalReady(latestTimestampRef.current);
      } catch (err) {
        if (cancelled) return;
        failedRef.current = true;
        console.error("Failed to load trajectory steering layer", err);
        signalReady(latestTimestampRef.current);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engineReady, enabled, rendererRef, signalReady]);

  useEffect(() => {
    if (!engineReady) return;
    const root = rootRef.current;
    if (root) root.visible = enabled;

    setActiveObjects(enabled, timestamp, fieldObjectsByHourKeyRef.current, activeFieldObjectsRef);
    setActiveObjects(enabled, timestamp, contourObjectsByHourKeyRef.current, activeContourObjectsRef);
    setActiveObjects(enabled, timestamp, markerObjectsByHourKeyRef.current, activeMarkerObjectsRef);
    setActiveObjects(
      enabled && style.contourGradientRibbon,
      timestamp,
      ribbonObjectsByHourKeyRef.current,
      activeRibbonObjectsRef
    );
    setActiveObjects(
      enabled && style.contourPulse,
      timestamp,
      pulseObjectsByHourKeyRef.current,
      activePulseObjectsRef
    );
    setActiveContourVisuals(enabled, timestamp, contourVisualsByHourKeyRef.current, activeContourVisualsRef);
    updateActiveContourVisuals(activeContourVisualsRef.current, style, performance.now() * 0.001);
    setPulseObjectsAlpha(activePulseObjectsRef.current, style.contourPulse ? 0.9 : 1.0);

    if (!enabled || loadedRef.current || failedRef.current) {
      signalReady(timestamp);
    }
  }, [engineReady, enabled, timestamp, style, signalReady]);

  useEffect(() => {
    if (!engineReady) return;
    const passKey = "trajectory-steering-pulse";

    if (!enabled || !style.contourPulse) {
      unregisterFramePass(passKey);
      updateActiveContourVisuals(activeContourVisualsRef.current, styleRef.current, performance.now() * 0.001);
      setPulseObjectsAlpha(activePulseObjectsRef.current, 1.0);
      return;
    }

    registerFramePass(passKey, (tick) => {
      const wave = 0.5 + 0.5 * Math.sin(tick.t * 0.0024);
      const alphaMul = 0.2 + 1.06 * Math.pow(wave, 1.55);
      setPulseObjectsAlpha(activePulseObjectsRef.current, alphaMul);
    });

    return () => {
      unregisterFramePass(passKey);
    };
  }, [
    engineReady,
    enabled,
    style.contourPulse,
    registerFramePass,
    unregisterFramePass,
  ]);

  return null;
}
