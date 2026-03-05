import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { potentialVorticityApiUrl } from "../utils/ApiResponses";
import { PVPressure, useControls } from "../../state/controlsStore";
import { configureDataTexture } from "./shaderUtils";

const SUPPORTED_LEVELS = [250, 500, 925] as const;
type SupportedLevel = (typeof SUPPORTED_LEVELS)[number];

function defaultPvRangeForLevel(level: number): { min: number; max: number } {
  if (level <= 300) return { min: -2e-6, max: 2.4e-5 };
  if (level <= 700) return { min: -1e-6, max: 1.2e-5 };
  return { min: -2e-7, max: 4e-6 };
}

function resolvePvLevel(pressure: PVPressure): SupportedLevel | null {
  if (pressure === "none") return null;
  return SUPPORTED_LEVELS.includes(pressure) ? pressure : 250;
}

type PVParams = ReturnType<typeof useControls.getState>["pv"];

function applyPvParams(mat: THREE.ShaderMaterial, p: PVParams, level: SupportedLevel) {
  const r = defaultPvRangeForLevel(level);
  mat.uniforms.uDataMin.value = r.min;
  mat.uniforms.uDataMax.value = r.max;

  mat.uniforms.uDisplayMin.value = p.uPvMin;
  mat.uniforms.uDisplayMax.value = p.uPvMax;
  mat.uniforms.uGamma.value = p.uGamma;
  mat.uniforms.uAlpha.value = p.uAlpha;
}

function animateFade(
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

export default function PotentialVorticityLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } = useEarthLayer("pv");

  const pressureLevel = useControls((st) => st.pv.pressureLevel);

  const meshARef = useRef<THREE.Mesh | null>(null);
  const meshBRef = useRef<THREE.Mesh | null>(null);

  const activeRef = useRef<"A" | "B">("A");
  const reqIdRef = useRef(0);
  const pendingRef = useRef<PVParams | null>(null);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;
    const s = useControls.getState();
    pendingRef.current = s.pv;

    const R = 100;
    const LIFT = R * 0.0022;
    const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

    const makeMaterial = () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        uniforms: {
          uTex: { value: null as THREE.Texture | null },
          uLonOffset: { value: 0.25 },
          uDataMin: { value: 0 },
          uDataMax: { value: 1 },
          uDisplayMin: { value: s.pv.uPvMin },
          uDisplayMax: { value: s.pv.uPvMax },
          uGamma: { value: s.pv.uGamma },
          uAlpha: { value: s.pv.uAlpha },
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

    const matA = makeMaterial();
    const matB = makeMaterial();

    const meshA = new THREE.Mesh(geom, matA);
    meshA.name = "potential-vorticity-layer-A";
    meshA.renderOrder = 56;
    meshA.frustumCulled = false;

    const meshB = new THREE.Mesh(geom, matB);
    meshB.name = "potential-vorticity-layer-B";
    meshB.renderOrder = 56;
    meshB.frustumCulled = false;

    matB.uniforms.uLayerOpacity.value = 0.0;

    const visible = s.pv.pressureLevel !== "none";
    meshA.visible = visible;
    meshB.visible = visible;

    scene.add(meshA);
    scene.add(meshB);

    meshARef.current = meshA;
    meshBRef.current = meshB;
    activeRef.current = "A";

    return () => {
      meshARef.current = null;
      meshBRef.current = null;

      meshA.removeFromParent();
      meshB.removeFromParent();
      geom.dispose();

      for (const mesh of [meshA, meshB]) {
        const mat = mesh.material as THREE.ShaderMaterial;
        const tex = mat.uniforms.uTex.value as THREE.Texture | null;
        if (tex) tex.dispose();
        mat.dispose();
      }
    };
  }, [engineReady, globeRef, sceneRef]);

  useEffect(() => {
    if (!engineReady) return;
    const meshA = meshARef.current;
    const meshB = meshBRef.current;
    if (!meshA || !meshB) return;

    pendingRef.current = useControls.getState().pv;

    const unsub = useControls.subscribe(
      (st) => st.pv,
      (p) => {
        pendingRef.current = p;
        const vis = p.pressureLevel !== "none";
        meshA.visible = vis;
        meshB.visible = vis;
      }
    );

    return () => {
      unsub();
    };
  }, [engineReady]);

  useEffect(() => {
    if (!engineReady) return;
    const meshA = meshARef.current;
    const meshB = meshBRef.current;
    if (!meshA || !meshB) return;

    let cancelled = false;
    const myReqId = ++reqIdRef.current;
    const isCancelled = () => cancelled || myReqId !== reqIdRef.current;

    const level = resolvePvLevel(pressureLevel);

    if (level === null) {
      meshA.visible = false;
      meshB.visible = false;
      signalReady(timestamp);
      return () => {
        cancelled = true;
      };
    }

    meshA.visible = true;
    meshB.visible = true;

    const activeKey = activeRef.current;
    const activeMesh = activeKey === "A" ? meshA : meshB;
    const nextMesh = activeKey === "A" ? meshB : meshA;

    const activeMat = activeMesh.material as THREE.ShaderMaterial;
    const nextMat = nextMesh.material as THREE.ShaderMaterial;

    const url = potentialVorticityApiUrl(timestamp, level);

    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (isCancelled()) {
          tex.dispose();
          return;
        }

        configureDataTexture(tex);

        const latest = pendingRef.current ?? useControls.getState().pv;
        applyPvParams(nextMat, latest, level);

        const prevNextTex = nextMat.uniforms.uTex.value as THREE.Texture | null;
        nextMat.uniforms.uTex.value = tex;
        nextMat.needsUpdate = true;
        if (prevNextTex) prevNextTex.dispose();

        nextMat.uniforms.uLayerOpacity.value = 0.0;
        activeMat.uniforms.uLayerOpacity.value = 1.0;

        const FADE_MS = 220;

        animateFade(
          FADE_MS,
          isCancelled,
          (t) => {
            activeMat.uniforms.uLayerOpacity.value = 1.0 - t;
            nextMat.uniforms.uLayerOpacity.value = t;
          },
          () => {
            if (isCancelled()) return;

            activeRef.current = activeKey === "A" ? "B" : "A";
            activeMat.uniforms.uLayerOpacity.value = 0.0;
            nextMat.uniforms.uLayerOpacity.value = 1.0;
          }
        );

        signalReady(timestamp);
      },
      undefined,
      (err) => {
        if (isCancelled()) return;
        console.error("Failed to load potential vorticity png", err);
        signalReady(timestamp);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [engineReady, pressureLevel, timestamp, signalReady]);

  return null;
}
