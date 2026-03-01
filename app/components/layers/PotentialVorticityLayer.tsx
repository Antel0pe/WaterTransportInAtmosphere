import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { potentialVorticityApiUrl } from "../utils/ApiResponses";
import { PVPressure, useControls } from "../../state/controlsStore";

const SUPPORTED_LEVELS = [250, 500, 925] as const;

function defaultPvRangeForLevel(level: number): { min: number; max: number } {
  if (level <= 300) return { min: -2e-6, max: 2.4e-5 };
  if (level <= 700) return { min: -1e-6, max: 1.2e-5 };
  return { min: -2e-7, max: 4e-6 };
}

function resolvePvLevel(
  pressure: PVPressure
): (typeof SUPPORTED_LEVELS)[number] | null {
  if (pressure === "none") return null;
  return SUPPORTED_LEVELS.includes(pressure) ? pressure : 250;
}

export default function PotentialVorticityLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } = useEarthLayer("pv");
  const meshRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;
    const s = useControls.getState();
    const level = resolvePvLevel(s.pv.pressureLevel) ?? 250;
    const r = defaultPvRangeForLevel(level);

    const R = 100;
    const LIFT = R * 0.0022;
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
        uDisplayMin: { value: s.pv.uPvMin },
        uDisplayMax: { value: s.pv.uPvMax },
        uGamma: { value: s.pv.uGamma },
        uAlpha: { value: s.pv.uAlpha },
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

          vec4 tex = texture2D(uTex, uv);
          float pv = mix(uDataMin, uDataMax, tex.r);

          float denom = max(uDisplayMax - uDisplayMin, 1e-12);
          float t = clamp((pv - uDisplayMin) / denom, 0.0, 1.0);
          t = pow(t, uGamma);

          vec3 col = palette(t);
          float alpha = smoothstep(0.02, 0.35, t) * clamp(uAlpha, 0.0, 1.0);

          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "potential-vorticity-layer";
    mesh.renderOrder = 56;
    mesh.frustumCulled = false;
    mesh.visible = s.pv.pressureLevel !== "none";

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
      (st) => st.pv,
      (p) => {
        const level = resolvePvLevel(p.pressureLevel) ?? 250;
        const r = defaultPvRangeForLevel(level);
        mesh.visible = p.pressureLevel !== "none";
        mat.uniforms.uDataMin.value = r.min;
        mat.uniforms.uDataMax.value = r.max;
        mat.uniforms.uDisplayMin.value = p.uPvMin;
        mat.uniforms.uDisplayMax.value = p.uPvMax;
        mat.uniforms.uGamma.value = p.uGamma;
        mat.uniforms.uAlpha.value = p.uAlpha;
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
    const pressure = useControls.getState().pv.pressureLevel;
    const level = resolvePvLevel(pressure);
    if (level === null) {
      mesh.visible = false;
      signalReady(timestamp);
      return;
    }

    mesh.visible = true;
    const url = potentialVorticityApiUrl(timestamp, level);

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
        mat.needsUpdate = true;
        if (prev) prev.dispose();

        signalReady(timestamp);
      },
      undefined,
      (err) => {
        console.error("Failed to load potential vorticity png", err);
        signalReady(timestamp);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [engineReady, timestamp, signalReady]);

  useEffect(() => {
    if (!engineReady) return;
    const unsubPressure = useControls.subscribe(
      (st) => st.pv.pressureLevel,
      (pressure) => {
        const mesh = meshRef.current;
        if (!mesh) return;
        const mat = mesh.material as THREE.ShaderMaterial;
        mesh.visible = pressure !== "none";
        const level = resolvePvLevel(pressure);
        if (level === null) {
          signalReady(timestamp);
          return;
        }

        const url = potentialVorticityApiUrl(timestamp, level);

        new THREE.TextureLoader().load(
          url,
          (tex) => {
            tex.colorSpace = THREE.NoColorSpace;
            tex.flipY = true;
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            const prev = mat.uniforms.uTex.value as THREE.Texture | null;
            mat.uniforms.uTex.value = tex;
            mat.needsUpdate = true;
            if (prev) prev.dispose();
            signalReady(timestamp);
          },
          undefined,
          (err) => {
            console.error("Failed to reload potential vorticity png", err);
            signalReady(timestamp);
          }
        );
      }
    );

    return () => {
      unsubPressure();
    };
  }, [engineReady, timestamp, signalReady]);

  return null;
}
