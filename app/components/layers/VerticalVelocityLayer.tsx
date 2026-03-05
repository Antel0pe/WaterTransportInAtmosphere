import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { verticalVelocityApiUrl } from "../utils/ApiResponses";
import { VerticalVelocityPressure, useControls } from "../../state/controlsStore";
import { configureDataTexture } from "./shaderUtils";

const SUPPORTED_LEVELS = [250, 500, 925] as const;
type SupportedLevel = (typeof SUPPORTED_LEVELS)[number];

function defaultRangeForLevel(level: SupportedLevel): { min: number; max: number } {
  if (level === 250) return { min: -12.417227745056152, max: 4.784543991088867 };
  if (level === 500) return { min: -19.965789794921875, max: 9.565109252929688 };
  return { min: -8.456122398376465, max: 9.214824676513672 };
}

function resolveLevel(pressure: VerticalVelocityPressure): SupportedLevel | null {
  if (pressure === "none") return null;
  return SUPPORTED_LEVELS.includes(pressure) ? pressure : 250;
}

type VerticalVelocityParams = ReturnType<typeof useControls.getState>["verticalVelocity"];

function applyVerticalVelocityParams(
  mat: THREE.ShaderMaterial,
  p: VerticalVelocityParams,
  level: SupportedLevel
) {
  const r = defaultRangeForLevel(level);
  mat.uniforms.uDataMin.value = r.min;
  mat.uniforms.uDataMax.value = r.max;

  mat.uniforms.uDisplayMin.value = p.uWMin;
  mat.uniforms.uDisplayMax.value = p.uWMax;
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

export default function VerticalVelocityLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("vertical-velocity");

  const pressureLevel = useControls((st) => st.verticalVelocity.pressureLevel);

  const meshARef = useRef<THREE.Mesh | null>(null);
  const meshBRef = useRef<THREE.Mesh | null>(null);

  const activeRef = useRef<"A" | "B">("A");
  const reqIdRef = useRef(0);
  const pendingRef = useRef<VerticalVelocityParams | null>(null);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;
    const s = useControls.getState();
    pendingRef.current = s.verticalVelocity;

    const R = 100;
    const LIFT = R * 0.0026;
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
          uDisplayMin: { value: s.verticalVelocity.uWMin },
          uDisplayMax: { value: s.verticalVelocity.uWMax },
          uGamma: { value: s.verticalVelocity.uGamma },
          uAlpha: { value: s.verticalVelocity.uAlpha },
          uZeroEps: { value: s.verticalVelocity.uZeroEps },
          uAsinhK: { value: s.verticalVelocity.uAsinhK },
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
uniform float uLayerOpacity;

varying vec2 vUv;

vec3 WARM = vec3(1.00, 0.08, 0.08);
vec3 COOL = vec3(0.10, 0.80, 0.72);
vec3 NEU  = vec3(0.86, 0.90, 1.00);

float saturateFast(float m) {
  m = clamp(m, 0.0, 1.0);
  float p = 3.0;
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

  float near0 = smoothstep(uZeroEps, uZeroEps * 2.0, m0);

  float m = pow(m0, max(uGamma, 1e-6));

  float s = saturateFast(m);

  vec3 signCol = (z < 0.0) ? WARM : COOL;

  vec3 base = mix(vec3(1.0), signCol, 0.25);
  vec3 col  = mix(base, signCol, s);

  float a = s * near0 * clamp(uAlpha, 0.0, 1.0);
  a *= clamp(uLayerOpacity, 0.0, 1.0);

  gl_FragColor = vec4(col, a);
}
        `,
      });

    const matA = makeMaterial();
    const matB = makeMaterial();

    const meshA = new THREE.Mesh(geom, matA);
    meshA.name = "vertical-velocity-layer-A";
    meshA.renderOrder = 58;
    meshA.frustumCulled = false;

    const meshB = new THREE.Mesh(geom, matB);
    meshB.name = "vertical-velocity-layer-B";
    meshB.renderOrder = 58;
    meshB.frustumCulled = false;

    matB.uniforms.uLayerOpacity.value = 0.0;

    const visible = s.verticalVelocity.pressureLevel !== "none";
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

    pendingRef.current = useControls.getState().verticalVelocity;

    const unsub = useControls.subscribe(
      (st) => st.verticalVelocity,
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

    const url = verticalVelocityApiUrl(timestamp, level);

    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (isCancelled()) {
          tex.dispose();
          return;
        }

        configureDataTexture(tex);

        const latest = pendingRef.current ?? useControls.getState().verticalVelocity;
        applyVerticalVelocityParams(nextMat, latest, level);

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
        console.error("Failed to load vertical velocity png", err);
        signalReady(timestamp);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [engineReady, pressureLevel, timestamp, signalReady]);

  return null;
}
