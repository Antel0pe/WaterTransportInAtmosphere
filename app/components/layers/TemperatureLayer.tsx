import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { temperatureApiUrl } from "../utils/ApiResponses";
import { TemperaturePressure, useControls } from "../../state/controlsStore";
import {
  animateUniform,
  configureDataTexture,
  crossfadeTextureUniforms,
  disposeCrossfadeTextures,
  loadDataTextureFromApi,
} from "./shaderUtils";

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

function applyTemperatureDisplayParams(
  mat: THREE.ShaderMaterial,
  p: TemperatureParams
) {
  mat.uniforms.uDisplayMin.value = p.uTempMin;
  mat.uniforms.uDisplayMax.value = p.uTempMax;
  mat.uniforms.uGamma.value = p.uGamma;
  mat.uniforms.uAlpha.value = p.uAlpha;
  mat.uniforms.uContrast.value = p.uContrast;
}

function applyTemperatureLoadedLevelParams(
  mat: THREE.ShaderMaterial,
  p: TemperatureParams,
  level: SupportedLevel
) {
  const r = defaultRangeForLevel(level);
  mat.uniforms.uDataMin.value = r.min;
  mat.uniforms.uDataMax.value = r.max;
  applyTemperatureDisplayParams(mat, p);
}

export default function TemperatureLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("temperature");

  const pressureLevel = useControls((st) => st.temperature.pressureLevel);

  const meshRef = useRef<THREE.Mesh | null>(null);
  const reqIdRef = useRef(0);
  const pendingRef = useRef<TemperatureParams | null>(null);
  const hasContentRef = useRef(false);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;
    const s = useControls.getState();
    pendingRef.current = s.temperature;

    const R = 100;
    const LIFT = R * 0.0028;
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

  float xA = texture2D(uTexA, uv).r;
  float xB = texture2D(uTexB, uv).r;
  float x = mix(xA, xB, clamp(uMix, 0.0, 1.0));

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

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "temperature-layer";
    mesh.renderOrder = 59;
    mesh.frustumCulled = false;
    mesh.visible = s.temperature.pressureLevel !== "none" && hasContentRef.current;

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

    pendingRef.current = useControls.getState().temperature;

    const unsub = useControls.subscribe(
      (st) => st.temperature,
      (p) => {
        pendingRef.current = p;
        mesh.visible = p.pressureLevel !== "none" && hasContentRef.current;
        if (hasContentRef.current) {
          applyTemperatureDisplayParams(mesh.material as THREE.ShaderMaterial, p);
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

    const level = resolveLevel(pressureLevel);

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

    const url = temperatureApiUrl(timestamp, level);

    void loadDataTextureFromApi({
      url,
      fallbackMessage: "Failed to load temperature data.",
      layerLabel: `Temperature (${level} hPa)`,
    })
      .then((tex) => {
        if (isCancelled()) {
          tex.dispose();
          return;
        }

        configureDataTexture(tex);

        const latest = pendingRef.current ?? useControls.getState().temperature;
        applyTemperatureLoadedLevelParams(mat, latest, level);

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
      })
      .catch((err) => {
        if (isCancelled()) return;
        console.error("Failed to load temperature png", err);
        if (!hasContentRef.current) {
          mesh.visible = false;
        }
        signalReady(timestamp);
      });

    return () => {
      cancelled = true;
    };
  }, [engineReady, pressureLevel, timestamp, signalReady]);

  return null;
}
