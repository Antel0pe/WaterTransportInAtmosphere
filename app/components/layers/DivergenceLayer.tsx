import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { divergenceApiUrl } from "../utils/ApiResponses";
import { DivergencePressure, useControls } from "../../state/controlsStore";

const SUPPORTED_LEVELS = [250, 500, 925] as const;
type SupportedLevel = (typeof SUPPORTED_LEVELS)[number];

function defaultRangeForLevel(level: SupportedLevel): { min: number; max: number } {
  if (level === 250) {
    return { min: -0.0005787129048258066, max: 0.0010109632275998592 };
  }
  if (level === 500) {
    return { min: -0.0005457177758216858, max: 0.0009189110714942217 };
  }
  return { min: -0.0011868530418723822, max: 0.0008237080182880163 };
}

function resolveLevel(pressure: DivergencePressure): SupportedLevel | null {
  if (pressure === "none") return null;
  return SUPPORTED_LEVELS.includes(pressure) ? pressure : 250;
}

export default function DivergenceLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("divergence");

  const meshRef = useRef<THREE.Mesh | null>(null);
  const pressureLevel = useControls((st) => st.divergence.pressureLevel);

  // init once
  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;
    const s = useControls.getState();
    const level = resolveLevel(s.divergence.pressureLevel) ?? 250;
    const r = defaultRangeForLevel(level);

    const R = 100;
    const LIFT = R * 0.0024;
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
  uDisplayMin: { value: s.divergence.uDivMin },
  uDisplayMax: { value: s.divergence.uDivMax },
  uGamma: { value: s.divergence.uGamma },
  uAlpha: { value: s.divergence.uAlpha },
  uZeroEps: { value: s.divergence.uZeroEps },
  uAsinhK: { value: s.divergence.uAsinhK },
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

varying vec2 vUv;

vec3 WARM = vec3(1.00, 0.85, 0.10); // golden yellow (divergence)
vec3 COOL = vec3(0.12, 0.78, 0.28); // emerald green (convergence)
vec3 NEU  = vec3(0.86, 0.90, 1.00); // cool pale neutral

float magMap(float m) {
  if (uAsinhK > 1e-6) {
    float k = uAsinhK;
    m = asinh(k * m) / asinh(k);
  }
  return pow(m, max(uGamma, 1e-6));
}

// fast saturation without extra uniforms:
// s = 1 - (1 - m)^p  (p>1 saturates faster)
float saturateFast(float m) {
  m = clamp(m, 0.0, 1.0);
  float p = 3.5; // bump to 4-5 if you want even faster saturation
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

  // boost to saturated color faster
  float s = saturateFast(m);

  // mask very close to 0 (deadzone)
  float eps = max(uZeroEps, 1e-6);
  float near0 = smoothstep(eps, eps * 2.0, m0);

  // alpha follows saturated strength (more visible sooner)
  float a = s * near0 * clamp(uAlpha, 0.0, 1.0);

  // div > 0 -> warm, div < 0 -> cool
  vec3 signCol = (z >= 0.0) ? WARM : COOL;
  vec3 col = mix(NEU, signCol, s);

  gl_FragColor = vec4(col, a);
}
      `,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "divergence-layer";
    mesh.renderOrder = 57;
    mesh.frustumCulled = false;
    mesh.visible = s.divergence.pressureLevel !== "none";

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
  }, [engineReady]);

  useEffect(() => {
    if (!engineReady) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    const mat = mesh.material as THREE.ShaderMaterial;

    const unsubParams = useControls.subscribe(
      (st) => st.divergence,
      (p) => {
        const level = resolveLevel(p.pressureLevel) ?? 250;
        const r = defaultRangeForLevel(level);

        mesh.visible = p.pressureLevel !== "none";
        mat.uniforms.uDataMin.value = r.min;
        mat.uniforms.uDataMax.value = r.max;
        mat.uniforms.uDisplayMin.value = p.uDivMin;
        mat.uniforms.uDisplayMax.value = p.uDivMax;
        mat.uniforms.uGamma.value = p.uGamma;
        mat.uniforms.uAlpha.value = p.uAlpha;
        mat.uniforms.uZeroEps.value = p.uZeroEps;
mat.uniforms.uAsinhK.value = p.uAsinhK;
      }
    );

    return () => {
      unsubParams();
    };
  }, [engineReady]);

  // update on timestamp or pressure change
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

    // Proof edit: never render during the load window.
    // If the blue/red flash disappears and becomes a brief gap, the cause is pre-ready sampling.
    mesh.visible = false;

    const url = divergenceApiUrl(timestamp, level);

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
        console.error("Failed to load divergence png", err);
        signalReady(timestamp);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [engineReady, pressureLevel, timestamp, signalReady]);

  return null;
}
