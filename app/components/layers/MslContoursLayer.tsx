// MslContoursLayer.tsx
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { useControls } from "../../state/controlsStore";
import { fetchMslContours, type MslContoursFile } from "../utils/ApiResponses";
import { latLonToVec3 } from "../utils/EarthUtils";

type ContoursPressure = ReturnType<typeof useControls.getState>["contoursPressure"];
type PressureNonNone = Exclude<ContoursPressure, "none">;

function animateT(
  ms: number,
  isCancelled: () => boolean,
  onUpdate: (t: number) => void,
  onDone?: () => void
) {
  const start = performance.now();
  function step(now: number) {
    if (isCancelled()) return;
    const t = Math.min(1, (now - start) / Math.max(ms, 1));
    onUpdate(t);
    if (t < 1) requestAnimationFrame(step);
    else onDone?.();
  }
  requestAnimationFrame(step);
}

function disposeGroupLines(group: THREE.Group) {
  group.traverse((obj) => {
    if (obj instanceof THREE.Line) {
      obj.geometry.dispose();
      // material disposed separately (we cache them)
    }
  });
}

function disposeMaterialCache(cache: Map<string, THREE.LineBasicMaterial>) {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}

function computeMinMaxHpa(
  file: MslContoursFile,
  pressure: PressureNonNone
): { min: number; max: number } {
  const fallback: Record<PressureNonNone, { min: number; max: number }> = {
    msl: { min: 920, max: 1060 },
    "250": { min: 9600, max: 11200 },
    "500": { min: 4600, max: 6000 },
    "925": { min: 500, max: 1100 },
  };

  const keys = Object.keys(file.levels);
  let mn = Infinity;
  let mx = -Infinity;
  for (const k of keys) {
    const v = Number(k);
    if (!Number.isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn === mx) return fallback[pressure];
  return { min: mn, max: mx };
}

function levelToColor(
  levelHpa: number,
  minHpa: number,
  maxHpa: number
): THREE.Color {
  let t = (levelHpa - minHpa) / (maxHpa - minHpa);
  t = THREE.MathUtils.clamp(t, 0, 1);

  const red = new THREE.Color(1.0, 0.0, 0.35);
  const green = new THREE.Color(0.0, 1.0, 0.15);
  return green.clone().lerp(red, t);
}

function buildContoursGroup(opts: {
  file: MslContoursFile;
  pressure: PressureNonNone;
  R: number;
  opacity: number;
  renderOrder: number;
}): { group: THREE.Group; mats: Map<string, THREE.LineBasicMaterial> } {
  const { file, pressure, R, opacity, renderOrder } = opts;

  const g = new THREE.Group();
  g.name = "msl-contours-slice";
  g.renderOrder = renderOrder;
  g.frustumCulled = false;

  const LIFT = R * 0.002;
  const { min, max } = computeMinMaxHpa(file, pressure);

  const mats = new Map<string, THREE.LineBasicMaterial>();

  const levelKeys = Object.keys(file.levels).sort((a, b) => parseFloat(a) - parseFloat(b));

  const getMaterialForLevel = (levelKey: string) => {
    const cached = mats.get(levelKey);
    if (cached) return cached;

    const levelHpa = parseFloat(levelKey);
    const col = levelToColor(levelHpa, min, max);

    const mat = new THREE.LineBasicMaterial({
      transparent: true,
      opacity, // will be animated later
      depthTest: true,
      depthWrite: false,
      color: col,
    });

    mats.set(levelKey, mat);
    return mat;
  };

  for (const levelKey of levelKeys) {
    const lines = file.levels[levelKey];
    if (!lines || lines.length === 0) continue;

    const material = getMaterialForLevel(levelKey);

    for (const line of lines) {
      if (!line || line.length < 2) continue;

      const positions = new Float32Array(line.length * 3);

      for (let i = 0; i < line.length; i++) {
        const [lonDeg, latDeg] = line[i];
        const v = latLonToVec3(latDeg, lonDeg, R + LIFT);
        const j = i * 3;
        positions[j + 0] = v.x;
        positions[j + 1] = v.y;
        positions[j + 2] = v.z;
      }

      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));

      const threeLine = new THREE.Line(geom, material);
      threeLine.frustumCulled = false;
      g.add(threeLine);
    }
  }

  return { group: g, mats };
}

function setMaterialsOpacity(mats: Map<string, THREE.LineBasicMaterial>, opacity: number) {
  for (const m of mats.values()) m.opacity = opacity;
}

export default function MslContoursLayer() {
  const contoursPressure = useControls((s) => s.contoursPressure);

  const layerKey = useMemo(() => `msl-contours-${contoursPressure}`, [contoursPressure]);
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer(layerKey);

  // Root holder that stays mounted.
  const rootRef = useRef<THREE.Group | null>(null);

  // Current visible slice (group + mats cache).
  const currentRef = useRef<{
    group: THREE.Group;
    mats: Map<string, THREE.LineBasicMaterial>;
  } | null>(null);

  // latest-request-wins
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;

    const root = new THREE.Group();
    root.name = "msl-contours-root";
    root.renderOrder = 60;
    root.frustumCulled = false;

    const s = useControls.getState();
    root.visible = s.contoursPressure !== "none";

    scene.add(root);
    rootRef.current = root;

    const unsubVis = useControls.subscribe(
      (st) => st.contoursPressure,
      (v) => {
        root.visible = v !== "none";
      }
    );

    return () => {
      unsubVis();

      // dispose current slice
      const cur = currentRef.current;
      if (cur) {
        disposeGroupLines(cur.group);
        cur.group.removeFromParent();
        disposeMaterialCache(cur.mats);
        currentRef.current = null;
      }

      rootRef.current = null;
      root.removeFromParent();
    };
  }, [engineReady, sceneRef, globeRef]);

  useEffect(() => {
    if (!engineReady) return;
    const root = rootRef.current;
    if (!root) return;

    let cancelled = false;
    const myReqId = ++reqIdRef.current;
    const isCancelled = () => cancelled || myReqId !== reqIdRef.current;

    if (contoursPressure === "none") {
      // Hide is handled by root.visible subscription; we can still clear geometry
      // but do it without flashing: just dispose current.
      const cur = currentRef.current;
      if (cur) {
        disposeGroupLines(cur.group);
        cur.group.removeFromParent();
        disposeMaterialCache(cur.mats);
        currentRef.current = null;
      }
      signalReady(timestamp);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const s = useControls.getState();
        const targetOpacity = s.mslContours.opacity;

        const file = await fetchMslContours(timestamp, contoursPressure);
        if (isCancelled()) return;

        const R = 100;

        // Build offscreen slice (not attached yet)
        const next = buildContoursGroup({
          file,
          pressure: contoursPressure,
          R,
          opacity: 0.0, // start invisible
          renderOrder: 60,
        });

        // Attach new slice immediately (but invisible)
        root.add(next.group);

        // Crossfade current -> next
        const prev = currentRef.current;

        const FADE_MS = 220;

        // ensure prev is at full opacity when starting fade
        if (prev) setMaterialsOpacity(prev.mats, targetOpacity);

        animateT(
          FADE_MS,
          isCancelled,
          (t) => {
            const a = targetOpacity * (1 - t);
            const b = targetOpacity * t;

            if (prev) setMaterialsOpacity(prev.mats, a);
            setMaterialsOpacity(next.mats, b);
          },
          () => {
            if (isCancelled()) {
              // if cancelled after fade, keep things consistent by disposing "next"
              disposeGroupLines(next.group);
              next.group.removeFromParent();
              disposeMaterialCache(next.mats);
              return;
            }

            // Commit: dispose prev slice
            if (prev) {
              disposeGroupLines(prev.group);
              prev.group.removeFromParent();
              disposeMaterialCache(prev.mats);
            }

            // Keep next as current
            currentRef.current = next;
          }
        );

        signalReady(timestamp);
      } catch (err) {
        if (isCancelled()) return;
        console.error("Failed to load/draw contours", err);
        // Keep old contours visible on error (no clearing)
        signalReady(timestamp);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engineReady, timestamp, signalReady, contoursPressure]);

  return null;
}