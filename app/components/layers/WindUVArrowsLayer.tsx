"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { useEarthLayer } from "./EarthBase";
import { useControls } from "../../state/controlsStore";
import { windUvRgApiUrl } from "../utils/ApiResponses";

import { latLonToVec3, getGlobeRadius } from "../utils/EarthUtils";

type WindDecodeParams = { uvMin: number; uvMax: number };

function decodeUvFromRG(r: number, g: number, p: WindDecodeParams) {
  const scale = 255.0 / (p.uvMax - p.uvMin);
  return { u: r / scale + p.uvMin, v: g / scale + p.uvMin };
}

function makeArrowGeometry() {
  // local arrow points +Y
  const shaftH = 0.7;
  const headH = 0.3;

  // 👇 add thickness knobs
  const shaftR = 0.035; // was 0.018
  const headR  = 0.09;  // was 0.05

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
  const pLon = latLonToVec3(latDeg, lonDeg + eps, radius, lonOffsetDeg, latOffsetDeg);
  const pLat = latLonToVec3(latDeg + eps, lonDeg, radius, lonOffsetDeg, latOffsetDeg);

  const dLon = pLon.sub(p);
  const dLat = pLat.sub(p);

  const n = p.clone().normalize();

  const east = dLon.sub(n.clone().multiplyScalar(dLon.dot(n))).normalize();
  const north = dLat.sub(n.clone().multiplyScalar(dLat.dot(n))).normalize();

  return { p, east, north };
}

export default function Wind925ArrowsLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("wind_925_arrows");

  const groupRef = useRef<THREE.Group | null>(null);
  const reqIdRef = useRef(0);

  const geomRef = useRef<THREE.BufferGeometry | null>(null);
  const matRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const instancedRef = useRef<THREE.InstancedMesh | null>(null);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;

    const g = new THREE.Group();
    g.name = "wind-925-arrows-layer";
    g.renderOrder = 55;
    g.frustumCulled = false;

    const st = useControls.getState() as any;
    g.visible = !!(st.layers?.wind925Arrows ?? true);

    scene.add(g);
    groupRef.current = g;

    const unsubVis = useControls.subscribe(
      (s) => (s as any).layers?.wind925Arrows,
      (v) => {
        g.visible = !!v;
      }
    );

    return () => {
      unsubVis();
      groupRef.current = null;

      g.removeFromParent();

      if (instancedRef.current) {
        instancedRef.current.removeFromParent();
        instancedRef.current = null;
      }
      if (geomRef.current) {
        geomRef.current.dispose();
        geomRef.current = null;
      }
      if (matRef.current) {
        matRef.current.dispose();
        matRef.current = null;
      }
    };
  }, [engineReady]);

  useEffect(() => {
    if (!engineReady) return;

    const g = groupRef.current;
    const globe = globeRef.current;
    if (!g || !globe) return;

    let cancelled = false;
    const myReqId = ++reqIdRef.current;
    const isCancelled = () => cancelled || myReqId !== reqIdRef.current;

    function clearGroup(group: THREE.Group) {
      const kids = [...group.children];
      for (const obj of kids) obj.removeFromParent();
    }

    function ensureResources() {
      if (!geomRef.current) geomRef.current = makeArrowGeometry();
      if (!matRef.current) {
        matRef.current = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0.9,
          depthTest: true,
          depthWrite: false,
          color: new THREE.Color(1, 1, 1),
        });
      }
      // after this, they are non-null
      return { geom: geomRef.current!, mat: matRef.current! };
    }

    function buildOrUpdateInstanced(group: THREE.Group, count: number) {
      const { geom, mat } = ensureResources();

      const existing = instancedRef.current;
      if (existing && existing.count === count) return existing;

      if (existing) {
        existing.removeFromParent();
        instancedRef.current = null;
      }

      const mesh = new THREE.InstancedMesh(geom, mat, count);
      mesh.frustumCulled = false;
      mesh.renderOrder = 55;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      instancedRef.current = mesh;
      group.add(mesh);
      return mesh;
    }

    async function loadImageData(url: string) {
      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);

      const bmp = await createImageBitmap(await res.blob());

      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("2d canvas unavailable");

      ctx.drawImage(bmp, 0, 0);
      const img = ctx.getImageData(0, 0, bmp.width, bmp.height);

      bmp.close();
      return img;
    }

    (async () => {
      try {
        clearGroup(g);

        const img = await loadImageData(windUvRgApiUrl(timestamp, 925));
        if (isCancelled()) return;

        const { width: W, height: H, data } = img;

        const R = 100;
        const LIFT = R * 0.003;

        const stride = 6;
        const minSpeed = 0.5;
        const maxInstancesHardCap = 80_000;

        const decodeParams: WindDecodeParams = { uvMin: -40, uvMax: 40 };

        const lonFromX = (x: number) => -180 + (x / W) * 360;
        const latFromY = (y: number) => 90 - (y / (H - 1)) * 180;

        let keep = 0;
        for (let y = 0; y < H; y += stride) {
          for (let x = 0; x < W; x += stride) {
            const i = (y * W + x) * 4;
            const { u, v } = decodeUvFromRG(data[i], data[i + 1], decodeParams);
            if (Math.hypot(u, v) >= minSpeed) keep++;
          }
        }
        keep = Math.min(keep, maxInstancesHardCap);

        const mesh = buildOrUpdateInstanced(g, keep);

        const up = new THREE.Vector3(0, 1, 0);
        const tmpQuat = new THREE.Quaternion();
        const tmpScale = new THREE.Vector3();
        const tmpMat = new THREE.Matrix4();

        const lengthBase = 0.9;
        const lengthPerMs = 0.06;
        const maxLen = 4.0;

        const lonOffsetDeg = 270;
        const latOffsetDeg = 0;

        let idx = 0;

        for (let y = 0; y < H; y += stride) {
          for (let x = 0; x < W; x += stride) {
            if (idx >= keep) break;

            const i = (y * W + x) * 4;
            const { u, v } = decodeUvFromRG(data[i], data[i + 1], decodeParams);
            const spd = Math.hypot(u, v);
            if (spd < minSpeed) continue;

            const lon = lonFromX(x + 0.5);
            const lat = latFromY(y + 0.5);

            const { p, east, north } = tangentEastNorth(
              lat,
              lon,
              R + LIFT,
              lonOffsetDeg,
              latOffsetDeg
            );

            const dir = east.clone().multiplyScalar(u).add(north.clone().multiplyScalar(v));
            if (dir.lengthSq() < 1e-12) continue;
            dir.normalize();

            tmpQuat.setFromUnitVectors(up, dir);

            const len = Math.min(maxLen, lengthBase + spd * lengthPerMs);
            tmpScale.set(1, len, 1);

            tmpMat.compose(p, tmpQuat, tmpScale);
            mesh.setMatrixAt(idx, tmpMat);

            idx++;
          }
          if (idx >= keep) break;
        }

        if (idx !== mesh.count) mesh.count = idx;
        mesh.instanceMatrix.needsUpdate = true;

        signalReady(timestamp);
      } catch (err) {
        if (isCancelled()) return;
        console.error("Failed to load/draw wind 925 arrows", err);
        signalReady(timestamp);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engineReady, timestamp, signalReady]);

  return null;
}
