import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { temperatureApiUrl } from "../utils/ApiResponses";
import { TemperaturePressure, useControls } from "../../state/controlsStore";

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

export default function TemperatureLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("temperature");

  const meshRef = useRef<THREE.Mesh | null>(null);
  const pressureLevel = useControls((st) => st.temperature.pressureLevel);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;
    const s = useControls.getState();
    const level = resolveLevel(s.temperature.pressureLevel) ?? 250;
    const r = defaultRangeForLevel(level);

    const R = 100;
    const LIFT = R * 0.0028;
    const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uTex: { value: null as THREE.Texture | null },
        uLonOffset: { value: 0.25 },
        uDataMin: { value: r.min },
        uDataMax: { value: r.max },
        uDisplayMin: { value: s.temperature.uTempMin },
        uDisplayMax: { value: s.temperature.uTempMax },
        uGamma: { value: s.temperature.uGamma },
        uAlpha: { value: s.temperature.uAlpha },
        uContrast: { value: s.temperature.uContrast },
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

varying vec2 vUv;

vec3 palette(float t) {
  t = clamp(t, 0.0, 1.0);

  // 7 stops: deep blue → cyan → near-white → yellow → orange → red → deep red
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

  // gamma (you already have this)
  t = pow(t, max(uGamma, 1e-6));

  // simple contrast around mid (no fancy curve)
  float c = max(uContrast, 1e-6);
  t = clamp((t - 0.5) * c + 0.5, 0.0, 1.0);

  vec3 col = palette(t);

  // constant alpha so subtle variations remain visible
  gl_FragColor = vec4(col, clamp(uAlpha, 0.0, 1.0));
}
      `,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "temperature-layer";
    mesh.renderOrder = 59;
    mesh.frustumCulled = false;
    mesh.visible = s.temperature.pressureLevel !== "none";

    scene.add(mesh);
    meshRef.current = mesh;

    return () => {
      meshRef.current = null;
      mesh.removeFromParent();
      geom.dispose();
      mat.dispose();
      const t = mat.uniforms.uTex.value as THREE.Texture | null;
      if (t) t.dispose();
    };
  }, [engineReady, globeRef, sceneRef]);

  useEffect(() => {
    if (!engineReady) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    const mat = mesh.material as THREE.ShaderMaterial;

    const unsubParams = useControls.subscribe(
      (st) => st.temperature,
      (p) => {
        const level = resolveLevel(p.pressureLevel) ?? 250;
        const r = defaultRangeForLevel(level);

        mesh.visible = p.pressureLevel !== "none";
        mat.uniforms.uDataMin.value = r.min;
        mat.uniforms.uDataMax.value = r.max;
        mat.uniforms.uDisplayMin.value = p.uTempMin;
        mat.uniforms.uDisplayMax.value = p.uTempMax;
        mat.uniforms.uGamma.value = p.uGamma;
        mat.uniforms.uAlpha.value = p.uAlpha;
        mat.uniforms.uContrast.value = p.uContrast;
      }
    );

    return () => {
      unsubParams();
    };
  }, [engineReady]);

  useEffect(() => {
    if (!engineReady) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    let cancelled = false;

    const mat = mesh.material as THREE.ShaderMaterial;
    const level = resolveLevel(pressureLevel);

    if (level === null) {
      mesh.visible = false;
      signalReady(timestamp);
      return;
    }

    const r = defaultRangeForLevel(level);

    mesh.visible = false;
    const url = temperatureApiUrl(timestamp, level);

    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (cancelled) {
          tex.dispose();
          return;
        }

        tex.colorSpace = THREE.NoColorSpace;
        tex.flipY = true;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;

        const prev = mat.uniforms.uTex.value as THREE.Texture | null;
        mat.uniforms.uTex.value = tex;
        mat.uniforms.uDataMin.value = r.min;
        mat.uniforms.uDataMax.value = r.max;
        mat.needsUpdate = true;
        mesh.visible = true;

        if (prev) prev.dispose();
        signalReady(timestamp);
      },
      undefined,
      (err) => {
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
