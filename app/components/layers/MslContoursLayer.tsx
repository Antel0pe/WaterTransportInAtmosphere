// MslContoursLayer.tsx
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { useControls } from "../../state/controlsStore";
import { fetchMslContours, type MslContoursFile } from "../utils/ApiResponses";
import { latLonToVec3 } from "../utils/EarthUtils";

type ContoursPressure = ReturnType<typeof useControls.getState>["contoursPressure"];
type PressureNonNone = Exclude<ContoursPressure, "none">;
type ContoursStyle = ReturnType<typeof useControls.getState>["mslContours"];
type ContoursSlice = {
  group: THREE.Group;
  mats: Map<string, THREE.LineBasicMaterial>;
  minHpa: number;
  maxHpa: number;
};

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

function disposeSlice(slice: ContoursSlice | null) {
  if (!slice) return;
  disposeGroupLines(slice.group);
  slice.group.removeFromParent();
  disposeMaterialCache(slice.mats);
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
  maxHpa: number,
  contrast: number
): THREE.Color {
  let t = (levelHpa - minHpa) / (maxHpa - minHpa);
  t = THREE.MathUtils.clamp(t, 0, 1);
  const width = 0.5 / Math.max(contrast, 1e-6);
  t = THREE.MathUtils.smoothstep(t, 0.5 - width, 0.5 + width);

  const red = new THREE.Color(1.0, 0.0, 0.35);
  const green = new THREE.Color(0.0, 1.0, 0.15);
  return green.clone().lerp(red, t);
}

function buildContoursGroup(opts: {
  file: MslContoursFile;
  pressure: PressureNonNone;
  R: number;
  opacity: number;
  contrast: number;
  renderOrder: number;
}): ContoursSlice {
  const { file, pressure, R, opacity, contrast, renderOrder } = opts;

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
      const col = levelToColor(levelHpa, min, max, contrast);

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

  return { group: g, mats, minHpa: min, maxHpa: max };
}

function setMaterialsOpacity(mats: Map<string, THREE.LineBasicMaterial>, opacity: number) {
  for (const m of mats.values()) m.opacity = opacity;
}

function setSliceOpacity(slice: ContoursSlice | null, opacity: number) {
  if (!slice) return;
  setMaterialsOpacity(slice.mats, opacity);
}

function setSliceContrast(slice: ContoursSlice | null, contrast: number) {
  if (!slice) return;
  for (const [levelKey, mat] of slice.mats.entries()) {
    const levelHpa = Number(levelKey);
    if (!Number.isFinite(levelHpa)) continue;
    mat.color.copy(levelToColor(levelHpa, slice.minHpa, slice.maxHpa, contrast));
  }
}

export default function MslContoursLayer() {
  const contoursPressure = useControls((s) => s.contoursPressure);

  const layerKey = useMemo(() => `msl-contours-${contoursPressure}`, [contoursPressure]);
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer(layerKey);

  // Root holder that stays mounted.
  const rootRef = useRef<THREE.Group | null>(null);

  // Current visible slice (group + mats cache).
  const currentRef = useRef<ContoursSlice | null>(null);
  const transitionRef = useRef<ContoursSlice | null>(null);
  const styleRef = useRef<ContoursStyle>(useControls.getState().mslContours);
  const fadeMixRef = useRef<number | null>(null);

  const applyVisibleOpacity = (targetOpacity: number) => {
    const mix = fadeMixRef.current;
    const current = currentRef.current;
    const transition = transitionRef.current;

    if (transition && mix !== null) {
      if (current) setSliceOpacity(current, targetOpacity * (1 - mix));
      setSliceOpacity(transition, targetOpacity * mix);
      return;
    }

    setSliceOpacity(current, targetOpacity);
  };

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
    styleRef.current = s.mslContours;

    scene.add(root);
    rootRef.current = root;

    const unsubVis = useControls.subscribe(
      (st) => st.contoursPressure,
      (v) => {
        root.visible = v !== "none";
      }
    );

    const unsubStyle = useControls.subscribe(
      (st) => st.mslContours,
      (p) => {
        styleRef.current = p;
        setSliceContrast(currentRef.current, p.contrast);
        setSliceContrast(transitionRef.current, p.contrast);
        applyVisibleOpacity(p.opacity);
      }
    );

    return () => {
      unsubVis();
      unsubStyle();

      // dispose current slice
      disposeSlice(transitionRef.current);
      transitionRef.current = null;
      fadeMixRef.current = null;
      disposeSlice(currentRef.current);
      currentRef.current = null;

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
      disposeSlice(transitionRef.current);
      transitionRef.current = null;
      fadeMixRef.current = null;
      disposeSlice(currentRef.current);
      currentRef.current = null;
      signalReady(timestamp);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const style = styleRef.current;

        const file = await fetchMslContours(timestamp, contoursPressure);
        if (isCancelled()) return;

        const R = 100;

        // Build offscreen slice (not attached yet)
        const next = buildContoursGroup({
          file,
          pressure: contoursPressure,
          R,
          opacity: 0.0, // start invisible
          contrast: style.contrast,
          renderOrder: 60,
        });

        // Attach new slice immediately (but invisible)
        root.add(next.group);
        transitionRef.current = next;

        // Crossfade current -> next
        const prev = currentRef.current;

        const FADE_MS = 220;

        // ensure prev is at full opacity when starting fade
        if (prev) setSliceContrast(prev, styleRef.current.contrast);
        fadeMixRef.current = 0;
        applyVisibleOpacity(styleRef.current.opacity);

        animateT(
          FADE_MS,
          isCancelled,
          (t) => {
            fadeMixRef.current = t;
            applyVisibleOpacity(styleRef.current.opacity);
          },
          () => {
            if (isCancelled()) {
              // if cancelled after fade, keep things consistent by disposing "next"
              if (transitionRef.current === next) transitionRef.current = null;
              fadeMixRef.current = null;
              disposeSlice(next);
              return;
            }

            // Commit: dispose prev slice
            disposeSlice(prev);

            // Keep next as current
            currentRef.current = next;
            if (transitionRef.current === next) transitionRef.current = null;
            fadeMixRef.current = null;
            applyVisibleOpacity(styleRef.current.opacity);
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
      if (transitionRef.current) {
        disposeSlice(transitionRef.current);
        transitionRef.current = null;
      }
      fadeMixRef.current = null;
    };
  }, [engineReady, timestamp, signalReady, contoursPressure]);

  return null;
}
