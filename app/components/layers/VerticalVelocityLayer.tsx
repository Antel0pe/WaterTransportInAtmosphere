import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { verticalVelocityApiUrl } from "../utils/ApiResponses";
import { VerticalVelocityPressure, useControls } from "../../state/controlsStore";

const SUPPORTED_LEVELS = [250, 500, 925] as const;
type SupportedLevel = (typeof SUPPORTED_LEVELS)[number];

function defaultRangeForLevel(level: SupportedLevel): { min: number; max: number } {
  if (level === 250) {
    return { min: -12.417227745056152, max: 4.784543991088867 };
  }
  if (level === 500) {
    return { min: -19.965789794921875, max: 9.565109252929688 };
  }
  return { min: -8.456122398376465, max: 9.214824676513672 };
}

function resolveLevel(pressure: VerticalVelocityPressure): SupportedLevel | null {
  if (pressure === "none") return null;
  return SUPPORTED_LEVELS.includes(pressure) ? pressure : 250;
}

export default function VerticalVelocityLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("vertical-velocity");

  const meshRef = useRef<THREE.Mesh | null>(null);
  const pressureLevel = useControls((st) => st.verticalVelocity.pressureLevel);

  // init once
  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;
    const s = useControls.getState();
    const level = resolveLevel(s.verticalVelocity.pressureLevel) ?? 250;
    const r = defaultRangeForLevel(level);

    const R = 100;
    const LIFT = R * 0.0026;
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
        uDisplayMin: { value: s.verticalVelocity.uWMin },
        uDisplayMax: { value: s.verticalVelocity.uWMax },
        uGamma: { value: s.verticalVelocity.uGamma },
        uAlpha: { value: s.verticalVelocity.uAlpha },
        uZeroEps: { value: s.verticalVelocity.uZeroEps },
        uAsinhK: { value: s.verticalVelocity.uAsinhK },
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

// already have this
uniform float uZeroEps;  // normalized deadzone around 0 (0..1)

varying vec2 vUv;

vec3 WARM = vec3(1.00, 0.08, 0.08); // red
vec3 COOL = vec3(0.20, 0.65, 1.00); // sky blue
vec3 NEU  = vec3(0.86, 0.90, 1.00); // cool pale blue-gray (less green/yellow)

// simple fast-saturation curve (no extra uniforms):
// s = 1 - (1 - m)^p  where p>1 saturates faster
float saturateFast(float m) {
  m = clamp(m, 0.0, 1.0);
  float p = 3.0;               // hardcoded: higher => faster saturation
  return 1.0 - pow(1.0 - m, p);
}

void main() {
  vec2 uv = vUv;
  uv.x = fract(uv.x + uLonOffset);

  // decode scalar
  float x = texture2D(uTex, uv).r;
  float value = mix(uDataMin, uDataMax, x);

  // clamp to display window
  float v = clamp(value, uDisplayMin, uDisplayMax);

  // normalize signed around 0 using symmetric scale
  float scale = max(abs(uDisplayMin), abs(uDisplayMax));
  scale = max(scale, 1e-12);
  float z = clamp(v / scale, -1.0, 1.0);  // signed [-1..1]

  // magnitude 0..1
  float m0 = abs(z);

  // mask near zero (deadzone)
  float near0 = smoothstep(uZeroEps, uZeroEps * 2.0, m0);

  // base contrast control (you already have uGamma)
  float m = pow(m0, max(uGamma, 1e-6));

  // make it saturate faster so it's not dull
  float s = saturateFast(m);

  // pick warm/cool by sign
  vec3 signCol = (z < 0.0) ? WARM : COOL;

vec3 base = mix(vec3(1.0), signCol, 0.25);  // very light tint of the sign color
vec3 col  = mix(base, signCol, s);          // same hue, just increasing saturation

  // alpha also follows s (visible quicker), but still masked near zero
  float a = s * near0 * clamp(uAlpha, 0.0, 1.0);

  gl_FragColor = vec4(col, a);
}
      `,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "vertical-velocity-layer";
    mesh.renderOrder = 58;
    mesh.frustumCulled = false;
    mesh.visible = s.verticalVelocity.pressureLevel !== "none";

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
      (st) => st.verticalVelocity,
      (p) => {
        const level = resolveLevel(p.pressureLevel) ?? 250;
        const r = defaultRangeForLevel(level);

        mesh.visible = p.pressureLevel !== "none";
        mat.uniforms.uDataMin.value = r.min;
        mat.uniforms.uDataMax.value = r.max;
        mat.uniforms.uDisplayMin.value = p.uWMin;
        mat.uniforms.uDisplayMax.value = p.uWMax;
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

    const url = verticalVelocityApiUrl(timestamp, level);

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
