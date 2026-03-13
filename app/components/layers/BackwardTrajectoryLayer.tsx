import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import {
  fetchBackwardTrajectory,
  type BackwardTrajectoryFile,
  type BackwardTrajectoryPoint,
} from "../utils/ApiResponses";
import { latLonToVec3 } from "../utils/EarthUtils";
import { useControls } from "../../state/controlsStore";

function clamp01(x: number) {
  return THREE.MathUtils.clamp(x, 0, 1);
}

function norm(value: number, min: number, max: number) {
  const denom = Math.max(max - min, 1e-9);
  return clamp01((value - min) / denom);
}

function computeRange(points: BackwardTrajectoryPoint[], key: keyof BackwardTrajectoryPoint) {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    const v = Number(p[key]);
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min, max: min + 1 };
  return { min, max };
}

function computeDerivedRange(
  points: BackwardTrajectoryPoint[],
  getter: (p: BackwardTrajectoryPoint) => number
) {
  let min = Infinity;
  let max = -Infinity;

  for (const p of points) {
    const v = getter(p);
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min, max: min + 1 };
  return { min, max };
}

function disposeObjectTree(root: THREE.Object3D) {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
      obj.geometry.dispose();
      const material = obj.material;
      if (Array.isArray(material)) {
        for (const m of material) m.dispose();
      } else {
        material.dispose();
      }
    }
  });
}

function makeLine(positions: Float32Array, material: THREE.LineBasicMaterial) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const line = new THREE.Line(geom, material);
  line.frustumCulled = false;
  return line;
}

function setActiveFinalContours(
  enabled: boolean,
  timestamp: string,
  contourObjectsByHourKey: Map<string, THREE.Object3D[]>,
  activeContourObjectsRef: { current: THREE.Object3D[] }
) {
  for (const obj of activeContourObjectsRef.current) {
    obj.visible = false;
  }
  activeContourObjectsRef.current = [];

  if (!enabled) return;

  const next = contourObjectsByHourKey.get(toHourlyKey(timestamp));
  if (!next || next.length === 0) return;

  for (const obj of next) {
    obj.visible = true;
  }
  activeContourObjectsRef.current = next;
}

function setActiveContourSnippets(
  enabled: boolean,
  timestamp: string,
  contourObjectsByHourKey: Map<string, THREE.Object3D[]>,
  activeContourObjectsRef: { current: THREE.Object3D[] }
) {
  for (const obj of activeContourObjectsRef.current) {
    obj.visible = false;
  }
  activeContourObjectsRef.current = [];

  if (!enabled) return;

  const next = contourObjectsByHourKey.get(toHourlyKey(timestamp));
  if (!next || next.length === 0) return;

  for (const obj of next) {
    obj.visible = true;
  }
  activeContourObjectsRef.current = next;
}

function setActiveGhostTrails(
  enabled: boolean,
  timestamp: string,
  ghostObjectsByHourKey: Map<string, THREE.Object3D[]>,
  activeGhostObjectsRef: { current: THREE.Object3D[] }
) {
  for (const obj of activeGhostObjectsRef.current) {
    obj.visible = false;
  }
  activeGhostObjectsRef.current = [];

  if (!enabled) return;

  const next = ghostObjectsByHourKey.get(toHourlyKey(timestamp));
  if (!next || next.length === 0) return;

  for (const obj of next) {
    obj.visible = true;
  }
  activeGhostObjectsRef.current = next;
}

type GhostTrailCell = {
  forwardHour: number;
  latitude: number;
  longitude_360: number;
};

function normalizeGhostCells(
  rawCells: BackwardTrajectoryPoint["ghost_forward_advected_cells"] | undefined
): GhostTrailCell[] {
  const cells = Array.isArray(rawCells) ? rawCells : [];
  return cells
    .map((cell) => ({
      forwardHour: Number(cell.forward_hour),
      latitude: Number(cell.latitude),
      longitude_360: Number.isFinite(Number(cell.longitude_360))
        ? Number(cell.longitude_360)
        : Number(cell.longitude),
    }))
    .filter(
      (cell) =>
        Number.isFinite(cell.forwardHour) &&
        Number.isFinite(cell.latitude) &&
        Number.isFinite(cell.longitude_360)
    )
    .sort((a, b) => a.forwardHour - b.forwardHour);
}

function gphToExtremaColor(levelM: number, minM: number, maxM: number) {
  const t = norm(levelM, minM, maxM);
  const blue = new THREE.Color(0x205cff);
  const neutral = new THREE.Color(0x8b8b8b);
  const red = new THREE.Color(0xff4a3a);
  if (t <= 0.5) return blue.clone().lerp(neutral, t * 2.0);
  return neutral.clone().lerp(red, (t - 0.5) * 2.0);
}

function buildContourFillMesh(
  points: Array<[number, number]>,
  R: number,
  lift: number,
  color: THREE.Color
) {
  if (!points || points.length < 4) return null;

  const ring = [...points];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (
    Math.hypot(Number(first[0]) - Number(last[0]), Number(first[1]) - Number(last[1])) <=
    1e-3
  ) {
    ring.pop();
  }
  if (ring.length < 3) return null;

  const vertices = ring.map(([lon, lat]) => latLonToVec3(lat, lon, R + lift));
  const center = new THREE.Vector3();
  for (const v of vertices) center.add(v);
  center.multiplyScalar(1 / vertices.length).normalize().multiplyScalar(R + lift);

  const triCount = vertices.length;
  const positions = new Float32Array(triCount * 9);
  for (let i = 0; i < triCount; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % triCount];
    const j = i * 9;
    positions[j + 0] = center.x;
    positions[j + 1] = center.y;
    positions[j + 2] = center.z;
    positions[j + 3] = a.x;
    positions[j + 4] = a.y;
    positions[j + 5] = a.z;
    positions[j + 6] = b.x;
    positions[j + 7] = b.y;
    positions[j + 8] = b.z;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.computeVertexNormals();

  const mat = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.23,
    depthTest: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  return mesh;
}

function splitContourPolyline(
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

type TrajectoryBuildResult = {
  group: THREE.Group;
  highlightMeshesByHourKey: Map<string, THREE.Mesh[]>;
  contourObjectsByHourKey: Map<string, THREE.Object3D[]>;
  finalContourObjectsByHourKey: Map<string, THREE.Object3D[]>;
  ghostObjectsByHourKey: Map<string, THREE.Object3D[]>;
};

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

function setActiveHighlights(
  enabled: boolean,
  timestamp: string,
  highlightMeshesByHourKey: Map<string, THREE.Mesh[]>,
  activeHighlightMeshesRef: { current: THREE.Mesh[] }
) {
  for (const mesh of activeHighlightMeshesRef.current) {
    mesh.visible = false;
  }
  activeHighlightMeshesRef.current = [];

  if (!enabled) return;

  const next = highlightMeshesByHourKey.get(toHourlyKey(timestamp));
  if (!next || next.length === 0) return;

  for (const mesh of next) {
    mesh.visible = true;
  }
  activeHighlightMeshesRef.current = next;
}

function buildTrajectoryGroup(file: BackwardTrajectoryFile, R: number): TrajectoryBuildResult {
  const points = [...file.points].sort((a, b) => a.step_hour - b.step_hour);

  const group = new THREE.Group();
  group.name = "backward-trajectory-group";
  group.frustumCulled = false;
  group.renderOrder = 66;
  const highlightMeshesByHourKey = new Map<string, THREE.Mesh[]>();
  const contourObjectsByHourKey = new Map<string, THREE.Object3D[]>();
  const finalContourObjectsByHourKey = new Map<string, THREE.Object3D[]>();
  const ghostObjectsByHourKey = new Map<string, THREE.Object3D[]>();

  const lift = R * 0.003;
  const contourLift = R * 0.0035;
  const finalContourLineLift = R * 0.0044;
  const finalContourFillLift = R * 0.0042;
  const ghostLift = R * 0.0048;

  const tcwRange = computeRange(points, "tcw_kg_m2");
  const gphRange = computeRange(points, "gph_m");
  const moistureDeltaAbsRange = computeDerivedRange(
    points,
    (p) => Math.abs(p.evap_mm_added - p.precip_mm)
  );
  const contourLevels = (file.metadata.contour_levels_m ?? [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  const contourScaleMin = contourLevels.length > 0 ? Math.min(...contourLevels) : 560;
  const contourScaleMax = contourLevels.length > 0 ? Math.max(...contourLevels) : 940;
  const contourScaleMaxSafe =
    contourScaleMax > contourScaleMin ? contourScaleMax : contourScaleMin + 1;
  const finalContourScaleMin = Number(file.metadata.final_extrema_contour_scale_m?.min);
  const finalContourScaleMax = Number(file.metadata.final_extrema_contour_scale_m?.max);
  const finalContourMin = Number.isFinite(finalContourScaleMin) ? finalContourScaleMin : 560;
  const finalContourMax = Number.isFinite(finalContourScaleMax) ? finalContourScaleMax : 940;
  const finalContourMaxSafe =
    finalContourMax > finalContourMin ? finalContourMax : finalContourMin + 1;

  const pathMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(0xe5f4ff),
    transparent: true,
    opacity: 0.92,
    depthTest: true,
    depthWrite: false,
  });

  const stemMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(0x7cc6ff),
    transparent: true,
    opacity: 0.72,
    depthTest: true,
    depthWrite: false,
  });

  const dotGeo = new THREE.SphereGeometry(0.45, 10, 10);
  const ghostDotGeo = new THREE.SphereGeometry(0.32, 9, 9);

  const pathPositions = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const v = latLonToVec3(p.latitude, p.longitude_360, R + lift);
    const j = i * 3;
    pathPositions[j + 0] = v.x;
    pathPositions[j + 1] = v.y;
    pathPositions[j + 2] = v.z;
  }
  group.add(makeLine(pathPositions, pathMat));

  const dotRedHue = 0.015;
  const dotBlueHue = 0.61;
  const dotSaturationMin = 0.45;
  const dotSaturationGamma = 0.6;
  const dotLightness = 0.52;
  const highlightMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xffd300),
    side: THREE.BackSide,
    transparent: true,
    opacity: 0.96,
    depthTest: true,
    depthWrite: false,
  });

  for (const p of points) {
    const base = latLonToVec3(p.latitude, p.longitude_360, R + lift);
    const normal = base.clone().normalize();

    const tcwT = norm(p.tcw_kg_m2, tcwRange.min, tcwRange.max);
    const gphT = norm(p.gph_m, gphRange.min, gphRange.max);

    const moistureDelta = p.evap_mm_added - p.precip_mm;
    const diffT = norm(
      Math.abs(moistureDelta),
      moistureDeltaAbsRange.min,
      moistureDeltaAbsRange.max
    );
    const saturationT =
      dotSaturationMin + (1 - dotSaturationMin) * Math.pow(diffT, dotSaturationGamma);
    const hue = moistureDelta >= 0 ? dotRedHue : dotBlueHue;
    const dotColor = new THREE.Color().setHSL(hue, saturationT, dotLightness);

    const dotMaterial = new THREE.MeshBasicMaterial({
      color: dotColor,
      depthTest: true,
      depthWrite: true,
    });

    const dot = new THREE.Mesh(dotGeo, dotMaterial);
    dot.position.copy(base);
    dot.scale.setScalar(0.55 + 1.35 * tcwT);
    dot.frustumCulled = false;
    dot.renderOrder = 67;
    group.add(dot);

    const highlight = new THREE.Mesh(dotGeo, highlightMat);
    highlight.visible = false;
    highlight.frustumCulled = false;
    highlight.scale.setScalar(1.25);
    highlight.renderOrder = 68;
    dot.add(highlight);

    const hourKey = toHourlyKey(p.valid_time);
    const meshesAtHour = highlightMeshesByHourKey.get(hourKey);
    if (meshesAtHour) meshesAtHour.push(highlight);
    else highlightMeshesByHourKey.set(hourKey, [highlight]);

    const ghostCells = normalizeGhostCells(p.ghost_forward_advected_cells);
    const ghostCellsTimeVarying = normalizeGhostCells(
      p.ghost_forward_advected_cells_timevarying
    );

    if (ghostCells.length > 0 || ghostCellsTimeVarying.length > 0) {
      const timedGhostObjects: THREE.Object3D[] = [];
      const start = latLonToVec3(p.latitude, p.longitude_360, R + ghostLift);

      const addGhostTrail = (cells: GhostTrailCell[], colorHex: number) => {
        if (cells.length === 0) return;

        const ghostPathPositions = new Float32Array((cells.length + 1) * 3);
        ghostPathPositions[0] = start.x;
        ghostPathPositions[1] = start.y;
        ghostPathPositions[2] = start.z;

        for (let i = 0; i < cells.length; i++) {
          const ghostCell = cells[i];
          const gv = latLonToVec3(ghostCell.latitude, ghostCell.longitude_360, R + ghostLift);
          const j = (i + 1) * 3;
          ghostPathPositions[j + 0] = gv.x;
          ghostPathPositions[j + 1] = gv.y;
          ghostPathPositions[j + 2] = gv.z;

          const ghostDot = new THREE.Mesh(
            ghostDotGeo,
            new THREE.MeshBasicMaterial({
              color: new THREE.Color(colorHex),
              transparent: true,
              opacity: 0.96,
              depthTest: true,
              depthWrite: false,
            })
          );
          ghostDot.position.copy(gv);
          ghostDot.visible = false;
          ghostDot.frustumCulled = false;
          ghostDot.renderOrder = 70;
          group.add(ghostDot);
          timedGhostObjects.push(ghostDot);
        }

        const ghostLine = makeLine(
          ghostPathPositions,
          new THREE.LineBasicMaterial({
            color: new THREE.Color(colorHex),
            transparent: true,
            opacity: 0.95,
            depthTest: true,
            depthWrite: false,
          })
        );
        ghostLine.visible = false;
        ghostLine.renderOrder = 70;
        group.add(ghostLine);
        timedGhostObjects.push(ghostLine);
      };

      addGhostTrail(ghostCells, 0xf9d548);
      addGhostTrail(ghostCellsTimeVarying, 0x5bd96a);

      const existingGhosts = ghostObjectsByHourKey.get(hourKey);
      if (existingGhosts) existingGhosts.push(...timedGhostObjects);
      else ghostObjectsByHourKey.set(hourKey, timedGhostObjects);
    }

    const stemStart = base.clone();
    const stemEnd = base.clone().addScaledVector(normal, 1.2 + 3.8 * gphT);
    const stemPos = new Float32Array([
      stemStart.x,
      stemStart.y,
      stemStart.z,
      stemEnd.x,
      stemEnd.y,
      stemEnd.z,
    ]);
    group.add(makeLine(stemPos, stemMat.clone()));

    const timedContourSnippets: THREE.Object3D[] = [];
    for (const contour of p.contours) {
      if (!contour.points || contour.points.length < 2) continue;
      const contourGph = Number.isFinite(Number(contour.gph_m))
        ? Number(contour.gph_m)
        : Number(contour.level_m);
      const contourColor = gphToExtremaColor(contourGph, contourScaleMin, contourScaleMaxSafe);

      for (const piece of splitContourPolyline(contour.points)) {
        const contourPos = new Float32Array(piece.length * 3);
        for (let i = 0; i < piece.length; i++) {
          const [lon, lat] = piece[i];
          const cv = latLonToVec3(lat, lon, R + contourLift);
          const j = i * 3;
          contourPos[j + 0] = cv.x;
          contourPos[j + 1] = cv.y;
          contourPos[j + 2] = cv.z;
        }

        const contourMat = new THREE.LineBasicMaterial({
          color: contourColor,
          transparent: true,
          opacity: 0.78,
          depthTest: true,
          depthWrite: false,
        });
        const contourLine = makeLine(contourPos, contourMat);
        contourLine.visible = false;
        contourLine.renderOrder = 68;
        group.add(contourLine);
        timedContourSnippets.push(contourLine);
      }
    }

    if (timedContourSnippets.length > 0) {
      const existing = contourObjectsByHourKey.get(hourKey);
      if (existing) existing.push(...timedContourSnippets);
      else contourObjectsByHourKey.set(hourKey, timedContourSnippets);
    }

    const timedContourObjects: THREE.Object3D[] = [];
    const extremaContours = p.final_extrema_contours;
    if (extremaContours && extremaContours.status !== "none") {
      const seen = new Set<string>();
      const candidates = [extremaContours.lower_contour, extremaContours.higher_contour];

      for (const contour of candidates) {
        if (!contour || !contour.points || contour.points.length < 2) continue;

        const contourKey = `${contour.branch}:${contour.segment_index}:${contour.level_m}`;
        if (seen.has(contourKey)) continue;
        seen.add(contourKey);

        const gphValue = Number.isFinite(Number(contour.gph_m))
          ? Number(contour.gph_m)
          : Number(contour.level_m);
        const contourColor = gphToExtremaColor(
          gphValue,
          finalContourMin,
          finalContourMaxSafe
        );

        for (const piece of splitContourPolyline(contour.points)) {
          const contourPos = new Float32Array(piece.length * 3);
          for (let i = 0; i < piece.length; i++) {
            const [lon, lat] = piece[i];
            const cv = latLonToVec3(lat, lon, R + finalContourLineLift);
            const j = i * 3;
            contourPos[j + 0] = cv.x;
            contourPos[j + 1] = cv.y;
            contourPos[j + 2] = cv.z;
          }

          const contourMat = new THREE.LineBasicMaterial({
            color: contourColor,
            transparent: true,
            opacity: 0.95,
            depthTest: true,
            depthWrite: false,
          });
          const line = makeLine(contourPos, contourMat);
          line.visible = false;
          line.renderOrder = 69;
          group.add(line);
          timedContourObjects.push(line);
        }

        if (contour.is_closed) {
          const fill = buildContourFillMesh(
            contour.points,
            R,
            finalContourFillLift,
            contourColor.clone()
          );
          if (fill) {
            fill.visible = false;
            fill.renderOrder = 65;
            group.add(fill);
            timedContourObjects.push(fill);
          }
        }
      }
    }

    if (timedContourObjects.length > 0) {
      const existing = finalContourObjectsByHourKey.get(hourKey);
      if (existing) existing.push(...timedContourObjects);
      else finalContourObjectsByHourKey.set(hourKey, timedContourObjects);
    }
  }

  return {
    group,
    highlightMeshesByHourKey,
    contourObjectsByHourKey,
    finalContourObjectsByHourKey,
    ghostObjectsByHourKey,
  };
}

export default function BackwardTrajectoryLayer() {
  const enabled = useControls((s) => s.layers.backwardTrajectory);
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("backward-trajectory");

  const rootRef = useRef<THREE.Group | null>(null);
  const contentRef = useRef<THREE.Group | null>(null);
  const highlightMeshesByHourKeyRef = useRef<Map<string, THREE.Mesh[]>>(new Map());
  const activeHighlightMeshesRef = useRef<THREE.Mesh[]>([]);
  const contourObjectsByHourKeyRef = useRef<Map<string, THREE.Object3D[]>>(new Map());
  const activeContourObjectsRef = useRef<THREE.Object3D[]>([]);
  const finalContourObjectsByHourKeyRef = useRef<Map<string, THREE.Object3D[]>>(new Map());
  const activeFinalContourObjectsRef = useRef<THREE.Object3D[]>([]);
  const ghostObjectsByHourKeyRef = useRef<Map<string, THREE.Object3D[]>>(new Map());
  const activeGhostObjectsRef = useRef<THREE.Object3D[]>([]);
  const loadedRef = useRef(false);
  const failedRef = useRef(false);
  const latestTimestampRef = useRef(timestamp);

  useEffect(() => {
    latestTimestampRef.current = timestamp;
  }, [timestamp]);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const root = new THREE.Group();
    root.name = "backward-trajectory-root";
    root.renderOrder = 66;
    root.frustumCulled = false;
    root.visible = false;

    sceneRef.current.add(root);
    rootRef.current = root;

    return () => {
      setActiveHighlights(
        false,
        latestTimestampRef.current,
        highlightMeshesByHourKeyRef.current,
        activeHighlightMeshesRef
      );
      highlightMeshesByHourKeyRef.current.clear();
      setActiveContourSnippets(
        false,
        latestTimestampRef.current,
        contourObjectsByHourKeyRef.current,
        activeContourObjectsRef
      );
      contourObjectsByHourKeyRef.current.clear();
      setActiveFinalContours(
        false,
        latestTimestampRef.current,
        finalContourObjectsByHourKeyRef.current,
        activeFinalContourObjectsRef
      );
      finalContourObjectsByHourKeyRef.current.clear();
      setActiveGhostTrails(
        false,
        latestTimestampRef.current,
        ghostObjectsByHourKeyRef.current,
        activeGhostObjectsRef
      );
      ghostObjectsByHourKeyRef.current.clear();

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
    const root = rootRef.current;
    if (!root) return;
    root.visible = enabled;
    setActiveHighlights(
      enabled,
      latestTimestampRef.current,
      highlightMeshesByHourKeyRef.current,
      activeHighlightMeshesRef
    );
    setActiveContourSnippets(
      enabled,
      latestTimestampRef.current,
      contourObjectsByHourKeyRef.current,
      activeContourObjectsRef
    );
    setActiveFinalContours(
      enabled,
      latestTimestampRef.current,
      finalContourObjectsByHourKeyRef.current,
      activeFinalContourObjectsRef
    );
    setActiveGhostTrails(
      enabled,
      latestTimestampRef.current,
      ghostObjectsByHourKeyRef.current,
      activeGhostObjectsRef
    );

    if (!enabled || loadedRef.current || failedRef.current) {
      signalReady(latestTimestampRef.current);
    }
  }, [enabled, signalReady]);

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
        const file = await fetchBackwardTrajectory();
        if (cancelled) return;

        const built = buildTrajectoryGroup(file, 100);
        root.add(built.group);
        contentRef.current = built.group;
        highlightMeshesByHourKeyRef.current = built.highlightMeshesByHourKey;
        contourObjectsByHourKeyRef.current = built.contourObjectsByHourKey;
        finalContourObjectsByHourKeyRef.current = built.finalContourObjectsByHourKey;
        ghostObjectsByHourKeyRef.current = built.ghostObjectsByHourKey;
        setActiveHighlights(
          enabled,
          latestTimestampRef.current,
          highlightMeshesByHourKeyRef.current,
          activeHighlightMeshesRef
        );
        setActiveContourSnippets(
          enabled,
          latestTimestampRef.current,
          contourObjectsByHourKeyRef.current,
          activeContourObjectsRef
        );
        setActiveFinalContours(
          enabled,
          latestTimestampRef.current,
          finalContourObjectsByHourKeyRef.current,
          activeFinalContourObjectsRef
        );
        setActiveGhostTrails(
          enabled,
          latestTimestampRef.current,
          ghostObjectsByHourKeyRef.current,
          activeGhostObjectsRef
        );
        loadedRef.current = true;
        failedRef.current = false;

        signalReady(latestTimestampRef.current);
      } catch (err) {
        if (cancelled) return;
        failedRef.current = true;
        console.error("Failed to load backward trajectory layer", err);
        signalReady(latestTimestampRef.current);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engineReady, enabled, signalReady]);

  useEffect(() => {
    if (!engineReady) return;

    if (!enabled) {
      setActiveHighlights(
        false,
        timestamp,
        highlightMeshesByHourKeyRef.current,
        activeHighlightMeshesRef
      );
      setActiveContourSnippets(
        false,
        timestamp,
        contourObjectsByHourKeyRef.current,
        activeContourObjectsRef
      );
      setActiveFinalContours(
        false,
        timestamp,
        finalContourObjectsByHourKeyRef.current,
        activeFinalContourObjectsRef
      );
      setActiveGhostTrails(
        false,
        timestamp,
        ghostObjectsByHourKeyRef.current,
        activeGhostObjectsRef
      );
      signalReady(timestamp);
      return;
    }

    setActiveHighlights(
      true,
      timestamp,
      highlightMeshesByHourKeyRef.current,
      activeHighlightMeshesRef
    );
    setActiveContourSnippets(
      true,
      timestamp,
      contourObjectsByHourKeyRef.current,
      activeContourObjectsRef
    );
    setActiveFinalContours(
      true,
      timestamp,
      finalContourObjectsByHourKeyRef.current,
      activeFinalContourObjectsRef
    );
    setActiveGhostTrails(
      true,
      timestamp,
      ghostObjectsByHourKeyRef.current,
      activeGhostObjectsRef
    );

    if (loadedRef.current || failedRef.current) {
      signalReady(timestamp);
    }
  }, [engineReady, enabled, timestamp, signalReady]);

  return null;
}
