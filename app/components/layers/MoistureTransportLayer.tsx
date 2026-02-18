// MoistureTransportLayer.tsx (client component)
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { totalColumnWaterApiUrl } from "../utils/ApiResponses";
import { useControls } from "../../state/controlsStore";

export default function MoistureTransportLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("moisture-transport");

  const meshRef = useRef<THREE.Mesh | null>(null);

  // init once
  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;

    const R = 100;
    const LIFT = R * 0.002; // sit slightly above earth surface
    const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

    // single source of truth: store defaults
    const s = useControls.getState();

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false, // important for overlay layers
      depthTest: true,
      uniforms: {
        uTex: { value: null as THREE.Texture | null },
        uLonOffset: { value: 0.5 }, // if you rolled lon in python by half

        uAnomMin: { value: s.moisture.uAnomMin },
        uAnomMax: { value: s.moisture.uAnomMax },
        uThreshold: { value: s.moisture.uThreshold },
        uGamma: { value: s.moisture.uGamma },
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

        varying vec2 vUv;

        // tiny hash for dithering (breaks banding)
        float hash12(vec2 p){
          vec3 p3  = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
          vec2 uv = vUv;
          uv.x = fract(uv.x + uLonOffset);

          float c = texture2D(uTex, uv).b; // 0..1
          float anom = mix(uAnomMin, uAnomMax, c);

          // keep only positive anomalies above threshold
          if (anom <= uThreshold) discard;

          // normalized intensity above threshold
          float t = clamp((anom - uThreshold) / (uAnomMax - uThreshold), 0.0, 1.0);
          t = pow(t, uGamma);

          // --- edge / filament enhancement ---
          // boost where intensity changes quickly (makes strands pop)
          float dx = abs(dFdx(t));
          float dy = abs(dFdy(t));
          float edge = clamp((dx + dy) * 6.0, 0.0, 1.0);

          // --- glow + core ---
          // soft body alpha, then add edge glow
          float bodyA = smoothstep(0.05, 0.25, t);
          float glowA = smoothstep(0.0, 1.0, edge) * 0.55;

          float alpha = clamp(bodyA * 0.55 + glowA, 0.0, 1.0);

          // --- color palette (reads over ocean) ---
          // deep -> mid -> hot
          vec3 deep = vec3(0.02, 0.18, 0.22);
          vec3 mid  = vec3(0.10, 0.85, 0.72);
          vec3 hot  = vec3(1.00, 0.90, 0.55);

          vec3 col = mix(deep, mid, smoothstep(0.15, 0.60, t));
          col = mix(col, hot, smoothstep(0.65, 1.00, t));

          // make edges brighter (outline-like)
          col += edge * vec3(0.55, 0.45, 0.25);

          // tiny dithering to reduce banding
          col += (hash12(gl_FragCoord.xy) - 0.5) * 0.015;

          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "moisture-transport-layer";
    mesh.renderOrder = 50; // draw after earth
    mesh.frustumCulled = false;

    // initial visibility from store
    mesh.visible = s.layers.moisture;

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

    // --- subscribe: visibility ---
    const unsubVis = useControls.subscribe(
      (st) => st.layers.moisture,
      (v) => {
        mesh.visible = v;
      }
    );

    // --- subscribe: moisture params ---
    const unsubParams = useControls.subscribe(
      (st) => st.moisture,
      (p) => {
        mat.uniforms.uAnomMin.value = p.uAnomMin;
        mat.uniforms.uAnomMax.value = p.uAnomMax;
        mat.uniforms.uThreshold.value = p.uThreshold;
        mat.uniforms.uGamma.value = p.uGamma;
      }
    );

    return () => {
      unsubVis();
      unsubParams();
    };
  }, [engineReady]);

  // update on timestamp: load new png as texture and set uniform
  useEffect(() => {
    if (!engineReady) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    let cancelled = false;

    const mat = mesh.material as THREE.ShaderMaterial;
    const url = totalColumnWaterApiUrl(timestamp);

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

        // swap + cleanup old
        const prev = mat.uniforms.uTex.value as THREE.Texture | null;
        mat.uniforms.uTex.value = tex;
        mat.needsUpdate = true;

        if (prev) prev.dispose();

        signalReady(timestamp);
      },
      undefined,
      (err) => {
        console.error("Failed to load moisture png", err);
        signalReady(timestamp);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [engineReady, timestamp, signalReady]);

  return null;
}
