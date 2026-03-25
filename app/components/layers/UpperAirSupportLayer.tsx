"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useEarthLayer } from "./EarthBase";
import {
  fetchUpperAirSupportFrame,
  fetchUpperAirSupportManifest,
  type UpperAirSupportFrame,
  type UpperAirSupportManifest,
  type UpperAirSupportPoint,
  type UpperAirSupportSample,
} from "../utils/ApiResponses";
import { latLonToVec3 } from "../utils/EarthUtils";
import { useControls } from "../../state/controlsStore";

type UpperAirSupportStyleState = {
  ascentThreshold: number;
  ascentOpacity: number;
  ascentGamma: number;
  divergenceThreshold: number;
  arrowSpacing: number;
  arrowScale: number;
  arrowOpacity: number;
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

type FrameDataEntry =
  | { status: "loading"; promise: Promise<void> }
  | { status: "ready"; frame: UpperAirSupportFrame }
  | { status: "missing" | "error" };

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

function sampleKey(lat: number, lon: number) {
  return `${lat.toFixed(4)}|${lon.toFixed(4)}`;
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

      void main() {
        gl_FragColor = vec4(vColor, vAlpha);
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
  if (nLat < 2 || nLon < 2 || count === 0) return null;

  const positions = new Float32Array(count * 3);
  const sampleMap = new Map<string, UpperAirSupportSample>();
  for (const sample of frame.samples) {
    sampleMap.set(sampleKey(sample.latitude, sample.longitude), sample);
  }

  const samples: Array<Array<UpperAirSupportSample | undefined>> = Array.from(
    { length: nLat },
    () => Array<UpperAirSupportSample | undefined>(nLon)
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

function makeArrowGeometry() {
  const shaftH = 0.7;
  const headH = 0.3;
  const shaftR = 0.035;
  const headR = 0.09;

  const shaft = new THREE.CylinderGeometry(shaftR, shaftR, shaftH, 10, 1, true);
  shaft.translate(0, shaftH * 0.5, 0);

  const head = new THREE.ConeGeometry(headR, headH, 14, 1, true);
  head.translate(0, shaftH + headH * 0.5, 0);

  const merged = BufferGeometryUtils.mergeGeometries([shaft, head], false);
  merged.computeVertexNormals();
  return merged;
}

function tangentEastNorth(
  latDeg: number,
  lonDeg: number,
  radius: number,
  lonOffsetDeg = 270,
  latOffsetDeg = 0
) {
  const eps = 1e-3;
  const p = latLonToVec3(latDeg, lonDeg, radius, lonOffsetDeg, latOffsetDeg);
  const pLon = latLonToVec3(
    latDeg,
    lonDeg + eps,
    radius,
    lonOffsetDeg,
    latOffsetDeg
  );
  const pLat = latLonToVec3(
    latDeg + eps,
    lonDeg,
    radius,
    lonOffsetDeg,
    latOffsetDeg
  );

  const dLon = pLon.sub(p);
  const dLat = pLat.sub(p);
  const n = p.clone().normalize();

  const east = dLon.sub(n.clone().multiplyScalar(dLon.dot(n))).normalize();
  const north = dLat.sub(n.clone().multiplyScalar(dLat.dot(n))).normalize();
  return { p, east, north };
}

function makeAscentMesh(
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
      const ascent = sample?.ascent_pa_s ?? 0;
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

  return makeVertexAlphaMesh(frameGrid.positions, frameGrid.indices, colors, alphas, 72);
}

function makeDivergenceArrowMesh(
  frameGrid: FrameGrid,
  manifest: UpperAirSupportManifest,
  style: UpperAirSupportStyleState,
  radius: number,
  lift: number
) {
  const ascentRef = Math.max(
    manifest.summary.ascent_p95_pa_s ?? manifest.summary.ascent_max_pa_s ?? 0,
    1e-6
  );
  const divergenceRef = Math.max(
    manifest.summary.divergence_p95_s1 ??
      manifest.summary.divergence_max_s1 ??
      0,
    1e-9
  );
  const windRef = Math.max(
    manifest.summary.wind_p95_ms ?? manifest.summary.wind_max_ms ?? 0,
    1e-6
  );

  const ascentThreshold = clamp01(style.ascentThreshold) * ascentRef;
  const divergenceThreshold = clamp01(style.divergenceThreshold) * divergenceRef;
  const spacing = Math.max(1, Math.round(style.arrowSpacing));

  const candidates: UpperAirSupportSample[] = [];
  for (let latIdx = 0; latIdx < frameGrid.nLat; latIdx += spacing) {
    for (let lonIdx = 0; lonIdx < frameGrid.nLon; lonIdx += spacing) {
      const sample = frameGrid.samples[latIdx][lonIdx];
      if (!sample) continue;
      if (sample.ascent_pa_s < ascentThreshold) continue;
      if (sample.divergence_s1 < divergenceThreshold) continue;
      if (sample.wind_speed_ms <= 0.0) continue;
      candidates.push(sample);
    }
  }

  if (candidates.length === 0) return null;

  const geom = makeArrowGeometry();
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xffe7a8),
    transparent: true,
    opacity: style.arrowOpacity,
    depthWrite: false,
    depthTest: true,
  });
  const mesh = new THREE.InstancedMesh(geom, mat, candidates.length);
  mesh.frustumCulled = false;
  mesh.renderOrder = 86;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const up = new THREE.Vector3(0, 1, 0);
  const tmpQuat = new THREE.Quaternion();
  const tmpScale = new THREE.Vector3();
  const tmpMat = new THREE.Matrix4();

  let idx = 0;
  for (const sample of candidates) {
    const { p, east, north } = tangentEastNorth(
      sample.latitude,
      sample.longitude,
      radius + lift
    );

    const dir = east
      .clone()
      .multiplyScalar(sample.u_wind_ms)
      .add(north.clone().multiplyScalar(sample.v_wind_ms));
    if (dir.lengthSq() < 1e-12) continue;
    dir.normalize();

    tmpQuat.setFromUnitVectors(up, dir);

    const divergenceNorm = clamp01(sample.divergence_s1 / divergenceRef);
    const windNorm = clamp01(sample.wind_speed_ms / windRef);
    const len =
      style.arrowScale *
      (0.7 + 0.6 * windNorm) *
      (0.35 + 0.85 * Math.pow(divergenceNorm, 0.85));

    tmpScale.set(1, len, 1);
    tmpMat.compose(p, tmpQuat, tmpScale);
    mesh.setMatrixAt(idx, tmpMat);
    idx += 1;
  }

  mesh.count = idx;
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function buildStaticContext(
  manifest: UpperAirSupportManifest,
  radius: number
): StaticBuildResult {
  const points = [...manifest.points].sort((a, b) => a.step_hour - b.step_hour);
  const group = new THREE.Group();
  group.name = "upper-air-support-static";
  group.frustumCulled = false;
  group.renderOrder = 80;

  const pathLift = radius * 0.00315;
  const markerLift = radius * 0.0042;
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

  const markerGeom = new THREE.SphereGeometry(radius * 0.0062, 14, 14);
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

function buildFrameVisual(
  frame: UpperAirSupportFrame,
  manifest: UpperAirSupportManifest,
  style: UpperAirSupportStyleState,
  radius: number
) {
  const group = new THREE.Group();
  group.name = `upper-air-support-frame-${frame.hour_key}`;
  group.frustumCulled = false;
  group.visible = false;
  group.renderOrder = 78;

  const fieldLift = radius * 0.00295;
  const arrowLift = radius * 0.0043;
  const frameGrid = buildFrameGrid(frame, radius, fieldLift);
  if (!frameGrid) return group;

  group.add(makeAscentMesh(frameGrid, manifest, style));
  const arrows = makeDivergenceArrowMesh(
    frameGrid,
    manifest,
    style,
    radius,
    arrowLift
  );
  if (arrows) group.add(arrows);

  return group;
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

export default function UpperAirSupportLayer() {
  const enabled = useControls((s) => s.layers.upperAirSupport);
  const upperAirSupport = useControls((s) => s.upperAirSupport);
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("upper-air-support");

  const style = useMemo<UpperAirSupportStyleState>(
    () => ({ ...upperAirSupport }),
    [upperAirSupport]
  );

  const [manifest, setManifest] = useState<UpperAirSupportManifest | null>(null);
  const [manifestFailed, setManifestFailed] = useState(false);
  const [cacheVersion, setCacheVersion] = useState(0);

  const rootRef = useRef<THREE.Group | null>(null);
  const staticGroupRef = useRef<THREE.Group | null>(null);
  const latestTimestampRef = useRef(timestamp);
  const manifestLoadingRef = useRef(false);

  const markerObjectsByHourKeyRef = useRef<Map<string, THREE.Object3D[]>>(new Map());
  const frameDataCacheRef = useRef<Map<string, FrameDataEntry>>(new Map());
  const frameObjectsByHourKeyRef = useRef<Map<string, THREE.Object3D[]>>(new Map());

  const activeMarkerObjectsRef = useRef<THREE.Object3D[]>([]);
  const activeFrameObjectsRef = useRef<THREE.Object3D[]>([]);

  useEffect(() => {
    latestTimestampRef.current = timestamp;
  }, [timestamp]);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const root = new THREE.Group();
    root.name = "upper-air-support-root";
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
      setActiveObjects(
        false,
        latestTimestampRef.current,
        frameObjectsByHourKeyRef.current,
        activeFrameObjectsRef
      );

      for (const objects of frameObjectsByHourKeyRef.current.values()) {
        for (const obj of objects) {
          disposeObjectTree(obj);
          obj.removeFromParent();
        }
      }
      frameObjectsByHourKeyRef.current.clear();
      frameDataCacheRef.current.clear();
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
  }, [engineReady, sceneRef, globeRef]);

  useEffect(() => {
    if (!engineReady || !enabled || manifest || manifestFailed) return;
    if (manifestLoadingRef.current) return;

    let cancelled = false;
    manifestLoadingRef.current = true;

    (async () => {
      try {
        const nextManifest = await fetchUpperAirSupportManifest();
        if (cancelled) return;
        setManifest(nextManifest);
        setManifestFailed(false);
      } catch (err) {
        if (cancelled) return;
        setManifestFailed(true);
        console.error("Failed to load upper air support manifest", err);
        signalReady(latestTimestampRef.current);
      } finally {
        if (!cancelled) manifestLoadingRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
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
    if (!manifest) return;

    setActiveObjects(
      false,
      latestTimestampRef.current,
      frameObjectsByHourKeyRef.current,
      activeFrameObjectsRef
    );
    for (const objects of frameObjectsByHourKeyRef.current.values()) {
      for (const obj of objects) {
        disposeObjectTree(obj);
        obj.removeFromParent();
      }
    }
    frameObjectsByHourKeyRef.current.clear();
    setCacheVersion((v) => v + 1);
  }, [manifest, style]);

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
      setActiveObjects(
        false,
        timestamp,
        frameObjectsByHourKeyRef.current,
        activeFrameObjectsRef
      );
      signalReady(timestamp);
      return;
    }

    if (manifestFailed) {
      setActiveObjects(
        false,
        timestamp,
        frameObjectsByHourKeyRef.current,
        activeFrameObjectsRef
      );
      signalReady(timestamp);
      return;
    }

    if (!manifest || !root) return;

    const currentHourKey = toHourlyKey(timestamp);
    const currentIndex = manifest.available_hour_keys.indexOf(currentHourKey);
    if (currentIndex === -1) {
      setActiveObjects(
        false,
        timestamp,
        frameObjectsByHourKeyRef.current,
        activeFrameObjectsRef
      );
      signalReady(timestamp);
      return;
    }

    const desiredHourKeys = manifest.available_hour_keys.slice(currentIndex, currentIndex + 3);
    const desiredSet = new Set(desiredHourKeys);

    for (const desiredHourKey of desiredHourKeys) {
      const existing = frameDataCacheRef.current.get(desiredHourKey);
      if (existing?.status === "ready") {
        if (!frameObjectsByHourKeyRef.current.has(desiredHourKey)) {
          const group = buildFrameVisual(existing.frame, manifest, style, 100);
          root.add(group);
          frameObjectsByHourKeyRef.current.set(desiredHourKey, [group]);
        }
        continue;
      }
      if (existing?.status === "loading") continue;
      if (!manifest.points_by_hour[desiredHourKey]) {
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

    for (const [hourKey, objects] of frameObjectsByHourKeyRef.current.entries()) {
      if (desiredSet.has(hourKey)) continue;
      for (const obj of objects) {
        disposeObjectTree(obj);
        obj.removeFromParent();
      }
      frameObjectsByHourKeyRef.current.delete(hourKey);
    }

    for (const [hourKey, entry] of frameDataCacheRef.current.entries()) {
      if (desiredSet.has(hourKey)) continue;
      if (entry.status === "loading") continue;
      frameDataCacheRef.current.delete(hourKey);
    }

    const currentEntry = frameDataCacheRef.current.get(currentHourKey);
    if (currentEntry?.status === "ready") {
      if (!frameObjectsByHourKeyRef.current.has(currentHourKey)) {
        const group = buildFrameVisual(currentEntry.frame, manifest, style, 100);
        root.add(group);
        frameObjectsByHourKeyRef.current.set(currentHourKey, [group]);
      }
      setActiveObjects(
        true,
        timestamp,
        frameObjectsByHourKeyRef.current,
        activeFrameObjectsRef
      );
      signalReady(timestamp);
      return;
    }

    if (currentEntry?.status === "missing" || currentEntry?.status === "error") {
      setActiveObjects(
        false,
        timestamp,
        frameObjectsByHourKeyRef.current,
        activeFrameObjectsRef
      );
      signalReady(timestamp);
      return;
    }

    setActiveObjects(
      false,
      timestamp,
      frameObjectsByHourKeyRef.current,
      activeFrameObjectsRef
    );
  }, [
    engineReady,
    enabled,
    timestamp,
    manifest,
    manifestFailed,
    cacheVersion,
    style,
    signalReady,
  ]);

  return null;
}
