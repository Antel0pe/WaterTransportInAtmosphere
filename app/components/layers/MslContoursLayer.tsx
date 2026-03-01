// MslContoursLayer.tsx
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { useControls } from "../../state/controlsStore";
import { fetchMslContours, type MslContoursFile } from "../utils/ApiResponses";
import { latLonToVec3 } from "../utils/EarthUtils";

export default function MslContoursLayer() {
  const contoursPressure = useControls((s) => s.contoursPressure);
  const layerKey = useMemo(
    () => `msl-contours-${contoursPressure}`,
    [contoursPressure]
  );

  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer(layerKey);

  const groupRef = useRef<THREE.Group | null>(null);
  const matsRef = useRef<Map<string, THREE.LineBasicMaterial>>(new Map());

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;

    const g = new THREE.Group();
    g.name = "msl-contours-layer";
    g.renderOrder = 60;
    g.frustumCulled = false;

    const s = useControls.getState();
    g.visible = s.contoursPressure !== "none";

    scene.add(g);
    groupRef.current = g;

    const unsubVis = useControls.subscribe(
      (st) => st.contoursPressure,
      (v) => {
        g.visible = v !== "none";
      }
    );

    return () => {
      unsubVis();

      groupRef.current = null;

      g.removeFromParent();

      g.traverse((obj) => {
        if (obj instanceof THREE.Line) {
          obj.geometry.dispose();
        }
      });

      for (const mat of matsRef.current.values()) mat.dispose();
      matsRef.current.clear();
    };
  }, [engineReady]);

  useEffect(() => {
    if (!engineReady) return;

    const g = groupRef.current;
    const globe = globeRef.current;
    if (!g || !globe) return;

    let cancelled = false;

    function clearGroup(group: THREE.Group) {
      const kids = [...group.children];
      for (const obj of kids) {
        obj.removeFromParent();
        if (obj instanceof THREE.Line) {
          obj.geometry.dispose();
        }
      }
    }

    function clearMaterialCache() {
      for (const mat of matsRef.current.values()) mat.dispose();
      matsRef.current.clear();
    }

    function computeMinMaxHpa(
      file: MslContoursFile,
      pressure: Exclude<typeof contoursPressure, "none">
    ): { min: number; max: number } {
      const fallback: Record<Exclude<typeof contoursPressure, "none">, { min: number; max: number }> = {
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
      if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn === mx) {
        return fallback[pressure];
      }
      return { min: mn, max: mx };
    }

    function applyContrast(t: number, contrast: number) {
      const x = (t - 0.5) * contrast + 0.5;
      return THREE.MathUtils.clamp(x, 0, 1);
    }
    function levelToColor(
      levelHpa: number,
      minHpa: number,
      maxHpa: number,
      contrast: number
    ): THREE.Color {
      let t = (levelHpa - minHpa) / (maxHpa - minHpa);
      t = THREE.MathUtils.clamp(t, 0, 1);
      t = applyContrast(t, contrast);

      // simple + high-contrast: red (low) -> green (high), pushed apart
      const red = new THREE.Color(1.0, 0.0, 0.35);   // slightly magenta-red (pops on ocean)
      const green = new THREE.Color(0.0, 1.0, 0.15); // slightly yellow-green (also pops)

      return green.clone().lerp(red, t);
    }

    function addContours(
      group: THREE.Group,
      file: MslContoursFile,
      pressure: Exclude<typeof contoursPressure, "none">,
      R: number
    ) {
      const LIFT = R * 0.002;

      const { min, max } = computeMinMaxHpa(file, pressure);

      const s = useControls.getState();
      const contrast = s.mslContours.contrast;
      const opacity = s.mslContours.opacity;

      const levelKeys = Object.keys(file.levels).sort(
        (a, b) => parseFloat(a) - parseFloat(b)
      );

      const getMaterialForLevel = (levelKey: string) => {
        const cached = matsRef.current.get(levelKey);
        if (cached) return cached;

        const levelHpa = parseFloat(levelKey);
        const col = levelToColor(levelHpa, min, max, contrast);

        const mat = new THREE.LineBasicMaterial({
          transparent: true,
          opacity,
          depthTest: true,
          depthWrite: false,
          color: col,
        });

        matsRef.current.set(levelKey, mat);
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

          group.add(threeLine);
        }
      }
    }

    if (contoursPressure === "none") {
      clearGroup(g);
      clearMaterialCache();
      signalReady(timestamp);
      return;
    }

    (async () => {
      try {
        clearGroup(g);
        clearMaterialCache();

        const file = await fetchMslContours(timestamp, contoursPressure);
        if (cancelled) return;

        const R = 100;
        addContours(g, file, contoursPressure, R);

        signalReady(timestamp);
      } catch (err) {
        console.error("Failed to load/draw contours", err);
        signalReady(timestamp);
      }
    })(); 

    const unsubParams = useControls.subscribe(
      (st) => st.mslContours,
      () => {
        // params changed -> rebuild colors/opacities
        if (cancelled) return;
        (async () => {
          try {
            clearGroup(g);
            clearMaterialCache();

            const file = await fetchMslContours(timestamp, contoursPressure);
            if (cancelled) return;

            const R = 100;
            addContours(g, file, contoursPressure, R);
          } catch (err) {
            console.error("Failed to redraw contours after param change", err);
          }
        })();
      }
    );

    return () => {
      cancelled = true;
      unsubParams();
    };
  }, [engineReady, timestamp, signalReady, contoursPressure]);

  return null;
}
