import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { temperatureApiUrl } from "../utils/ApiResponses";
import { TemperaturePressure, useControls } from "../../state/controlsStore";
import { configureDataTexture } from "./shaderUtils";

const SUPPORTED_LEVELS = [250, 500, 925] as const;
type SupportedLevel = (typeof SUPPORTED_LEVELS)[number];

const ENCODED_RANGE_BY_LEVEL: Record<SupportedLevel, { min: number; max: number }> = {
  250: { min: 180, max: 330 },
  500: { min: 180, max: 330 },
  925: { min: 180, max: 330 },
};

function defaultRangeForLevel(level: SupportedLevel): { min: number; max: number } {
  return ENCODED_RANGE_BY_LEVEL[level];
}

function resolveLevel(pressure: TemperaturePressure): SupportedLevel | null {
  if (pressure === "none") return null;
  return SUPPORTED_LEVELS.includes(pressure) ? pressure : 250;
}

type TemperatureParams = ReturnType<typeof useControls.getState>["temperature"];

function applyTemperatureParams(mat: THREE.ShaderMaterial, p: TemperatureParams, level: SupportedLevel) {
  const r = defaultRangeForLevel(level);
  mat.uniforms.uDataMin.value = r.min;
  mat.uniforms.uDataMax.value = r.max;

  mat.uniforms.uDisplayMin.value = p.uTempMin;
  mat.uniforms.uDisplayMax.value = p.uTempMax;
  mat.uniforms.uGamma.value = p.uGamma;
  mat.uniforms.uAlpha.value = p.uAlpha;
  mat.uniforms.uContrast.value = p.uContrast;
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

export default function TemperatureLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("temperature");

  const pressureLevel = useControls((st) => st.temperature.pressureLevel);

  const meshARef = useRef<THREE.Mesh | null>(null);
  const meshBRef = useRef<THREE.Mesh | null>(null);

  const activeRef = useRef<"A" | "B">("A");
  const reqIdRef = useRef(0);
  const pendingRef = useRef<TemperatureParams | null>(null);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;
    const s = useControls.getState();
    pendingRef.current = s.temperature;

    const R = 100;
    const LIFT = R * 0.0028;

    // Option A: give the two transparent spheres *slightly different radii* to avoid depth-tie flicker.
    const EPS = R * 0.00002; // ~0.002 for R=100 (tiny)
    const geomA = new THREE.SphereGeometry(R + LIFT, 128, 128);
    const geomB = new THREE.SphereGeometry(R + LIFT + EPS, 128, 128);

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
          uDisplayMin: { value: s.temperature.uTempMin },
          uDisplayMax: { value: s.temperature.uTempMax },
          uGamma: { value: s.temperature.uGamma },
          uAlpha: { value: s.temperature.uAlpha },
          uContrast: { value: s.temperature.uContrast },
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
uniform float uContrast;
uniform float uLayerOpacity;

varying vec2 vUv;

vec3 palette(float t) {
  t = clamp(t, 0.0, 1.0);

  vec3 c0 = vec3(0.05, 0.18, 0.85);
  vec3 c1 = vec3(0.05, 0.65, 0.95);
  vec3 c2 = vec3(0.92, 0.97, 0.98);
  vec3 c3 = vec3(0.99, 0.92, 0.50);
  vec3 c4 = vec3(0.99, 0.55, 0.15);
  vec3 c5 = vec3(0.92, 0.18, 0.10);
  vec3 c6 = vec3(0.60, 0.00, 0.10);

  if (t < 0.15) return mix(c0, c1, (t - 0.00) / 0.15);
  if (t < 0.40) return mix(c1, c2, (t - 0.15) / 0.25);
  if (t < 0.55) return mix(c2, c3, (t - 0.40) / 0.15);
  if (t < 0.70) return mix(c3, c4, (t - 0.55) / 0.15);
  if (t < 0.85) return mix(c4, c5, (t - 0.70) / 0.15);
  return mix(c5, c6, (t - 0.85) / 0.15);
}

void main() {
  vec2 uv = vUv;
  uv.x = fract(uv.x + uLonOffset);

  float x = texture2D(uTex, uv).r;
  float tempK = mix(uDataMin, uDataMax, x);

  float denom = max(uDisplayMax - uDisplayMin, 1e-6);
  float t = clamp((tempK - uDisplayMin) / denom, 0.0, 1.0);

  t = pow(t, max(uGamma, 1e-6));

  float c = max(uContrast, 1e-6);
  t = clamp((t - 0.5) * c + 0.5, 0.0, 1.0);

  vec3 col = palette(t);
  float alpha = clamp(uAlpha, 0.0, 1.0) * clamp(uLayerOpacity, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
        `,
      });

    const matA = makeMaterial();
    const matB = makeMaterial();

    const meshA = new THREE.Mesh(geomA, matA);
    meshA.name = "temperature-layer-A";
    meshA.renderOrder = 59;
    meshA.frustumCulled = false;

    const meshB = new THREE.Mesh(geomB, matB);
    meshB.name = "temperature-layer-B";
    meshB.renderOrder = 60;
    meshB.frustumCulled = false;

    matB.uniforms.uLayerOpacity.value = 0.0;

    const visible = s.temperature.pressureLevel !== "none";
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

      geomA.dispose();
      geomB.dispose();

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

    pendingRef.current = useControls.getState().temperature;

    const unsub = useControls.subscribe(
      (st) => st.temperature,
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

    const level = resolveLevel(pressureLevel);

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

    const url = temperatureApiUrl(timestamp, level);

    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (isCancelled()) {
          tex.dispose();
          return;
        }

        configureDataTexture(tex);

        const latest = pendingRef.current ?? useControls.getState().temperature;
        applyTemperatureParams(nextMat, latest, level);

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
        console.error("Failed to load temperature png", err);
        signalReady(timestamp);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [engineReady, pressureLevel, timestamp, signalReady]);

  return null;
}