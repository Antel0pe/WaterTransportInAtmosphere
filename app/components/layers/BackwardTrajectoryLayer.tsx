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

function buildTrajectoryGroup(file: BackwardTrajectoryFile, R: number) {
  const points = [...file.points].sort((a, b) => a.step_hour - b.step_hour);

  const group = new THREE.Group();
  group.name = "backward-trajectory-group";
  group.frustumCulled = false;
  group.renderOrder = 66;

  const lift = R * 0.003;
  const contourLift = R * 0.0035;

  const tcwRange = computeRange(points, "tcw_kg_m2");
  const gphRange = computeRange(points, "gph_m");
  const activityRange = computeDerivedRange(
    points,
    (p) => Math.max(0, p.evap_mm_added + p.precip_mm)
  );
  const contourRange = computeDerivedRange(
    points,
    (p) =>
      p.contours.reduce((mx, c) => Math.max(mx, Number(c.level_m)), Number.NEGATIVE_INFINITY)
  );

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

  const dotBlue = new THREE.Color(0x4a78ff);
  const dotRed = new THREE.Color(0xff5b5b);
  const dotNeutral = new THREE.Color(0x8c8c8c);
  const contourLow = new THREE.Color(0x2e6dff);
  const contourHigh = new THREE.Color(0xff4536);

  for (const p of points) {
    const base = latLonToVec3(p.latitude, p.longitude_360, R + lift);
    const normal = base.clone().normalize();

    const tcwT = norm(p.tcw_kg_m2, tcwRange.min, tcwRange.max);
    const gphT = norm(p.gph_m, gphRange.min, gphRange.max);

    const moistureDelta = p.evap_mm_added - p.precip_mm;
    const activity = Math.max(0, p.evap_mm_added + p.precip_mm);
    const saturationT = norm(activity, activityRange.min, activityRange.max);

    let hue = dotNeutral;
    if (moistureDelta > 1e-9) hue = dotRed;
    else if (moistureDelta < -1e-9) hue = dotBlue;

    const dotColor = dotNeutral.clone().lerp(hue, saturationT);

    const dotMaterial = new THREE.MeshBasicMaterial({
      color: dotColor,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
      depthWrite: false,
    });

    const dot = new THREE.Mesh(dotGeo, dotMaterial);
    dot.position.copy(base);
    dot.scale.setScalar(0.55 + 1.35 * tcwT);
    dot.frustumCulled = false;
    group.add(dot);

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

    for (const contour of p.contours) {
      if (!contour.points || contour.points.length < 2) continue;
      const contourPos = new Float32Array(contour.points.length * 3);

      for (let i = 0; i < contour.points.length; i++) {
        const [lon, lat] = contour.points[i];
        const cv = latLonToVec3(lat, lon, R + contourLift);
        const j = i * 3;
        contourPos[j + 0] = cv.x;
        contourPos[j + 1] = cv.y;
        contourPos[j + 2] = cv.z;
      }

      const contourT = norm(Number(contour.level_m), contourRange.min, contourRange.max);
      const contourColor = contourLow.clone().lerp(contourHigh, contourT);
      const contourMat = new THREE.LineBasicMaterial({
        color: contourColor,
        transparent: true,
        opacity: 0.78,
        depthTest: true,
        depthWrite: false,
      });
      group.add(makeLine(contourPos, contourMat));
    }
  }

  return group;
}

export default function BackwardTrajectoryLayer() {
  const enabled = useControls((s) => s.layers.backwardTrajectory);
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("backward-trajectory");

  const rootRef = useRef<THREE.Group | null>(null);
  const contentRef = useRef<THREE.Group | null>(null);
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

        const next = buildTrajectoryGroup(file, 100);
        root.add(next);
        contentRef.current = next;
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
      signalReady(timestamp);
      return;
    }

    if (loadedRef.current || failedRef.current) {
      signalReady(timestamp);
    }
  }, [engineReady, enabled, timestamp, signalReady]);

  return null;
}
