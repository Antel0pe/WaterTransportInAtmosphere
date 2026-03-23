import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { potentialVorticityApiUrl } from "../utils/ApiResponses";
import { PVPressure, useControls } from "../../state/controlsStore";
import {
  animateUniform,
  configureDataTexture,
  crossfadeTextureUniforms,
  disposeCrossfadeTextures,
} from "./shaderUtils";

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

function applyPvDisplayParams(mat: THREE.ShaderMaterial, p: PVParams) {
  mat.uniforms.uDisplayMin.value = p.uPvMin;
  mat.uniforms.uDisplayMax.value = p.uPvMax;
  mat.uniforms.uGamma.value = p.uGamma;
  mat.uniforms.uAlpha.value = p.uAlpha;
}

function applyPvLoadedLevelParams(
  mat: THREE.ShaderMaterial,
  p: PVParams,
  level: SupportedLevel
) {
  const r = defaultPvRangeForLevel(level);
  mat.uniforms.uDataMin.value = r.min;
  mat.uniforms.uDataMax.value = r.max;
  applyPvDisplayParams(mat, p);
}

export default function PotentialVorticityLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } = useEarthLayer("pv");

  const pressureLevel = useControls((st) => st.pv.pressureLevel);

  const meshRef = useRef<THREE.Mesh | null>(null);
  const reqIdRef = useRef(0);
  const pendingRef = useRef<PVParams | null>(null);
  const hasContentRef = useRef(false);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;
    const s = useControls.getState();
    pendingRef.current = s.pv;

    const R = 100;
    const LIFT = R * 0.0022;
    const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uTexA: { value: null as THREE.Texture | null },
        uTexB: { value: null as THREE.Texture | null },
        uMix: { value: 0.0 },
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
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uMix;
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

  float xA = texture2D(uTexA, uv).r;
  float xB = texture2D(uTexB, uv).r;
  float x = mix(xA, xB, clamp(uMix, 0.0, 1.0));
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

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "potential-vorticity-layer";
    mesh.renderOrder = 56;
    mesh.frustumCulled = false;
    mesh.visible = s.pv.pressureLevel !== "none" && hasContentRef.current;

    scene.add(mesh);
    meshRef.current = mesh;

    return () => {
      meshRef.current = null;

      mesh.removeFromParent();
      geom.dispose();

      disposeCrossfadeTextures(mat);
      mat.dispose();
    };
  }, [engineReady, globeRef, sceneRef]);

  useEffect(() => {
    if (!engineReady) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    pendingRef.current = useControls.getState().pv;

    const unsub = useControls.subscribe(
      (st) => st.pv,
      (p) => {
        pendingRef.current = p;
        mesh.visible = p.pressureLevel !== "none" && hasContentRef.current;
        if (hasContentRef.current) {
          applyPvDisplayParams(mesh.material as THREE.ShaderMaterial, p);
        }
      }
    );

    return () => {
      unsub();
    };
  }, [engineReady]);

  useEffect(() => {
    if (!engineReady) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    const mat = mesh.material as THREE.ShaderMaterial;

    let cancelled = false;
    const myReqId = ++reqIdRef.current;
    const isCancelled = () => cancelled || myReqId !== reqIdRef.current;

    const level = resolvePvLevel(pressureLevel);

    if (level === null) {
      hasContentRef.current = false;
      mesh.visible = false;
      disposeCrossfadeTextures(mat);
      mat.uniforms.uTexA.value = null;
      mat.uniforms.uTexB.value = null;
      mat.uniforms.uMix.value = 0.0;
      mat.uniforms.uLayerOpacity.value = 0.0;
      mat.needsUpdate = true;
      signalReady(timestamp);
      return () => {
        cancelled = true;
      };
    }

    mesh.visible = hasContentRef.current;

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
        applyPvLoadedLevelParams(mat, latest, level);

        const hadVisibleContent = hasContentRef.current;
        hasContentRef.current = true;
        mesh.visible = true;

        if (!hadVisibleContent) {
          disposeCrossfadeTextures(mat);
          mat.uniforms.uTexA.value = tex;
          mat.uniforms.uTexB.value = tex;
          mat.uniforms.uMix.value = 0.0;
          mat.uniforms.uLayerOpacity.value = 0.0;
          mat.needsUpdate = true;

          animateUniform(mat, "uLayerOpacity", 0.0, 1.0, 220, isCancelled);
          signalReady(timestamp);
          return;
        }

        mat.uniforms.uLayerOpacity.value = 1.0;
        crossfadeTextureUniforms({
          material: mat,
          nextTexture: tex,
          isCancelled,
        });
        signalReady(timestamp);
      },
      undefined,
      (err) => {
        if (isCancelled()) return;
        console.error("Failed to load potential vorticity png", err);
        if (!hasContentRef.current) {
          mesh.visible = false;
        }
        signalReady(timestamp);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [engineReady, pressureLevel, timestamp, signalReady]);

  return null;
}
