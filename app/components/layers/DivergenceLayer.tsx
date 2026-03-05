import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { divergenceApiUrl } from "../utils/ApiResponses";
import { DivergencePressure, useControls } from "../../state/controlsStore";
import { configureDataTexture } from "./shaderUtils";

const SUPPORTED_LEVELS = [250, 500, 925] as const;
type SupportedLevel = (typeof SUPPORTED_LEVELS)[number];

function defaultRangeForLevel(level: SupportedLevel): { min: number; max: number } {
  if (level === 250) return { min: -0.0005787129048258066, max: 0.0010109632275998592 };
  if (level === 500) return { min: -0.0005457177758216858, max: 0.0009189110714942217 };
  return { min: -0.0011868530418723822, max: 0.0008237080182880163 };
}

function resolveLevel(pressure: DivergencePressure): SupportedLevel | null {
  if (pressure === "none") return null;
  return SUPPORTED_LEVELS.includes(pressure) ? pressure : 250;
}

type DivergenceParams = ReturnType<typeof useControls.getState>["divergence"];

function applyDivergenceParams(mat: THREE.ShaderMaterial, p: DivergenceParams, level: SupportedLevel) {
  const r = defaultRangeForLevel(level);
  mat.uniforms.uDataMin.value = r.min;
  mat.uniforms.uDataMax.value = r.max;

  mat.uniforms.uDisplayMin.value = p.uDivMin;
  mat.uniforms.uDisplayMax.value = p.uDivMax;
  mat.uniforms.uGamma.value = p.uGamma;
  mat.uniforms.uAlpha.value = p.uAlpha;
  mat.uniforms.uZeroEps.value = p.uZeroEps;
  mat.uniforms.uAsinhK.value = p.uAsinhK;
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

export default function DivergenceLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("divergence");

  const pressureLevel = useControls((st) => st.divergence.pressureLevel);

  const meshARef = useRef<THREE.Mesh | null>(null);
  const meshBRef = useRef<THREE.Mesh | null>(null);

  // which mesh is currently "active"/visible
  const activeRef = useRef<"A" | "B">("A");

  // latest-request-wins
  const reqIdRef = useRef(0);

  // latest UI params snapshot
  const pendingRef = useRef<DivergenceParams | null>(null);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;
    const s = useControls.getState();
    pendingRef.current = s.divergence;

    const R = 100;
    const LIFT = R * 0.0024;
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

          uDisplayMin: { value: s.divergence.uDivMin },
          uDisplayMax: { value: s.divergence.uDivMax },
          uGamma: { value: s.divergence.uGamma },
          uAlpha: { value: s.divergence.uAlpha },
          uZeroEps: { value: s.divergence.uZeroEps },
          uAsinhK: { value: s.divergence.uAsinhK },

          // NEW: per-mesh fade control
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

uniform float uZeroEps;
uniform float uAsinhK;

uniform float uLayerOpacity;

varying vec2 vUv;

vec3 WARM = vec3(1.00, 0.85, 0.10);
vec3 COOL = vec3(0.12, 0.78, 0.28);
vec3 NEU  = vec3(0.86, 0.90, 1.00);

float magMap(float m) {
  if (uAsinhK > 1e-6) {
    float k = uAsinhK;
    m = asinh(k * m) / asinh(k);
  }
  return pow(m, max(uGamma, 1e-6));
}

float saturateFast(float m) {
  m = clamp(m, 0.0, 1.0);
  float p = 3.5;
  return 1.0 - pow(1.0 - m, p);
}

void main() {
  vec2 uv = vUv;
  uv.x = fract(uv.x + uLonOffset);

  float x = texture2D(uTex, uv).r;
  float value = mix(uDataMin, uDataMax, x);

  float v = clamp(value, uDisplayMin, uDisplayMax);

  float scale = max(abs(uDisplayMin), abs(uDisplayMax));
  scale = max(scale, 1e-12);

  float z = clamp(v / scale, -1.0, 1.0);

  float m0 = abs(z);
  float m  = magMap(m0);
  float s  = saturateFast(m);

  float eps = max(uZeroEps, 1e-6);
  float near0 = smoothstep(eps, eps * 2.0, m0);

  float a = s * near0 * clamp(uAlpha, 0.0, 1.0);
  a *= clamp(uLayerOpacity, 0.0, 1.0);

  vec3 signCol = (z >= 0.0) ? WARM : COOL;
  vec3 col = mix(NEU, signCol, s);

  gl_FragColor = vec4(col, a);
}
        `,
      });

    const matA = makeMaterial();
    const matB = makeMaterial();

    const meshA = new THREE.Mesh(geom, matA);
    meshA.name = "divergence-layer-A";
    meshA.renderOrder = 57;
    meshA.frustumCulled = false;

    const meshB = new THREE.Mesh(geom, matB);
    meshB.name = "divergence-layer-B";
    meshB.renderOrder = 57;
    meshB.frustumCulled = false;

    // start with B invisible
    (matB.uniforms.uLayerOpacity.value as number) = 0.0;

    const visible = s.divergence.pressureLevel !== "none";
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

      // shared geometry
      geom.dispose();

      for (const mesh of [meshA, meshB]) {
        const mat = mesh.material as THREE.ShaderMaterial;
        const tex = mat.uniforms.uTex.value as THREE.Texture | null;
        if (tex) tex.dispose();
        mat.dispose();
      }
    };
  }, [engineReady, globeRef, sceneRef]);

  // Subscribe: keep params fresh (no uniform apply here)
  useEffect(() => {
    if (!engineReady) return;
    const meshA = meshARef.current;
    const meshB = meshBRef.current;
    if (!meshA || !meshB) return;

    pendingRef.current = useControls.getState().divergence;

    const unsub = useControls.subscribe(
      (st) => st.divergence,
      (p) => {
        pendingRef.current = p;
        const vis = p.pressureLevel !== "none";
        meshA.visible = vis;
        meshB.visible = vis;
      }
    );

    return () => unsub();
  }, [engineReady]);

  // Load + crossfade between meshes (no flashing)
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

    const url = divergenceApiUrl(timestamp, level);

    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (isCancelled()) {
          tex.dispose();
          return;
        }

        configureDataTexture(tex);

        // apply params to NEXT material only (safe; it's currently faded out)
        const latest = pendingRef.current ?? useControls.getState().divergence;
        applyDivergenceParams(nextMat, latest, level);

        // swap texture on next material
        const prevNextTex = nextMat.uniforms.uTex.value as THREE.Texture | null;
        nextMat.uniforms.uTex.value = tex;
        nextMat.needsUpdate = true;
        if (prevNextTex) prevNextTex.dispose();

        // Ensure start state
        nextMat.uniforms.uLayerOpacity.value = 0.0;
        activeMat.uniforms.uLayerOpacity.value = 1.0;

        const FADE_MS = 220;

        animateFade(
          FADE_MS,
          isCancelled,
          (t) => {
            // crossfade opacities
            activeMat.uniforms.uLayerOpacity.value = 1.0 - t;
            nextMat.uniforms.uLayerOpacity.value = t;
          },
          () => {
            if (isCancelled()) return;

            // commit: make next the active mesh
            activeRef.current = activeKey === "A" ? "B" : "A";

            // keep old mesh at 0 opacity (still around for next transition)
            activeMat.uniforms.uLayerOpacity.value = 0.0;
            nextMat.uniforms.uLayerOpacity.value = 1.0;
          }
        );

        signalReady(timestamp);
      },
      undefined,
      (err) => {
        if (isCancelled()) return;
        console.error("Failed to load divergence png", err);
        // keep current visible; don't change anything
        signalReady(timestamp);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [engineReady, pressureLevel, timestamp, signalReady]);

  return null;
}