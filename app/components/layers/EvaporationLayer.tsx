// EvaporationLayer.tsx
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { evaporationApiUrl } from "../utils/ApiResponses";
import { useControls } from "../../state/controlsStore";

export default function EvaporationLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("evaporation");

  const meshRef = useRef<THREE.Mesh | null>(null);

  // init once
  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;

    const R = 100;
    const LIFT = R * 0.002;
    const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

    const s = useControls.getState();

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uTex: { value: null as THREE.Texture | null },
        uLonOffset: { value: 0.25 },

        // We now visualize the BLUE channel from the RGB PNG:
        //   B encodes the anomaly display value: anom_disp = -(inst - clim_per_hour)
        // The PNG stores 8-bit [0..255] -> texture channels [0..1]
        // We remap B from [0..1] to anomaly in physical units using min/max.
        uAnomMin: { value: s.evap.uEvapMin },
        uAnomMax: { value: s.evap.uEvapMax },

        // display controls
        uThreshold: { value: s.evap.uThreshold },
        uGamma: { value: s.evap.uGamma },
        uAlphaScale: { value: s.evap.uAlphaScale },

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

        uniform float uAnomMin;
        uniform float uAnomMax;

        uniform float uThreshold;
        uniform float uGamma;
        uniform float uAlphaScale;

        varying vec2 vUv;

        void main() {
          vec2 uv = vUv;
          uv.x = fract(uv.x + uLonOffset);

          float b01 = texture2D(uTex, uv).b; // 0..1
          float anom = mix(uAnomMin, uAnomMax, b01); // physical units

          // Keep ONLY "more evap than baseline"
          // (per your encoding: anom > 0 means more evap than baseline)
          if (anom <= uThreshold) discard;

          // Map anomaly to 0..1 intensity
          // Use (uAnomMax - uThreshold) as the usable headroom
          float t = (anom - uThreshold) / max(uAnomMax - uThreshold, 1e-12);
          t = clamp(t, 0.0, 1.0);
          t = pow(t, uGamma);

          // Simple color: bright blue
          vec3 col = vec3(t, 0.0, 0.0);
          float alpha = clamp(t * uAlphaScale, 0.0, 1.0);

          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "evaporation-anomaly-layer";
    mesh.renderOrder = 50;
    mesh.frustumCulled = false;

    mesh.visible = s.layers.evaporation;

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

    const unsubVis = useControls.subscribe(
      (st) => st.layers.evaporation,
      (v) => {
        mesh.visible = v;
      }
    );

    const unsubParams = useControls.subscribe(
      (st) => st.evap,
      (p) => {
        mat.uniforms.uAnomMin.value = p.uEvapMin;
        mat.uniforms.uAnomMax.value = p.uEvapMax;
        mat.uniforms.uThreshold.value = p.uThreshold;
        mat.uniforms.uGamma.value = p.uGamma;
        mat.uniforms.uAlphaScale.value = p.uAlphaScale;
      }
    );

    return () => {
      unsubVis();
      unsubParams();
    };
  }, [engineReady]);

  useEffect(() => {
    if (!engineReady) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    let cancelled = false;
    const mat = mesh.material as THREE.ShaderMaterial;

    const url = evaporationApiUrl(timestamp);

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
        console.error("Failed to load evaporation png", err);
        signalReady(timestamp);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [engineReady, timestamp, signalReady]);

  return null;
}
