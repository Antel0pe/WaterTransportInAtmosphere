// EvaporationLayer.tsx (client component)
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { moistureTransportApiUrl } from "../utils/ApiResponses";
import { useControls } from "../../state/controlsStore";


export default function EvaporationLayer() {
    const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
        useEarthLayer("evaporation");

    const meshRef = useRef<THREE.Mesh | null>(null);

    // ---- tune these ----
    const EVAP_MIN = 0.0;
    const EVAP_MAX = 0.003;

    // "red threshold": hide everything below this evap
    const EVAP_THRESHOLD = 0.0004; // try 0.0002–0.001

    // intensity shaping for "brighter red" as evap increases
    const GAMMA = 0.8; // <1 boosts mid values, >1 compresses
    const ALPHA_SCALE = 0.9;

    // init once
    useEffect(() => {
        if (!engineReady) return;
        if (!sceneRef.current || !globeRef.current) return;

        const scene = sceneRef.current;

        const R = 100;
        const LIFT = R * 0.002;
        const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

        const mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            uniforms: {
                uTex: { value: null as THREE.Texture | null },
                uLonOffset: { value: 0.5 },

                uEvapMin: { value: EVAP_MIN },
                uEvapMax: { value: EVAP_MAX },
                uThreshold: { value: EVAP_THRESHOLD },
                uGamma: { value: GAMMA },
                uAlphaScale: { value: ALPHA_SCALE },
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

        uniform float uEvapMin;
        uniform float uEvapMax;
        uniform float uThreshold;
        uniform float uGamma;
        uniform float uAlphaScale;

        varying vec2 vUv;

        float hash12(vec2 p){
          vec3 p3  = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
          vec2 uv = vUv;
          uv.x = fract(uv.x + uLonOffset);

          // green channel encodes 0..1, mapped to true evap via [uEvapMin, uEvapMax]
          float g = texture2D(uTex, uv).g; // 0..1
          float evap = mix(uEvapMin, uEvapMax, g);

          // red threshold: hide weak evap
          if (evap <= uThreshold) discard;

          // normalized intensity above threshold
          float t = clamp((evap - uThreshold) / (uEvapMax - uThreshold), 0.0, 1.0);
          t = pow(t, uGamma);

          // pure red, brighter as evap increases
          vec3 col = vec3(t, 0.0, 0.0);

          // alpha also increases with evap; keep a soft ramp
          float alpha = clamp(t * uAlphaScale, 0.0, 1.0);

          // tiny dithering to reduce banding
          col += (hash12(gl_FragCoord.xy) - 0.5) * 0.01;

          gl_FragColor = vec4(col, alpha);
        }
      `,
        });

        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = "evaporation-layer";
        mesh.renderOrder = 50;
        mesh.frustumCulled = false;

        scene.add(mesh);
        meshRef.current = mesh;

        return () => {
            meshRef.current = null;
            mesh.removeFromParent();
            geom.dispose();
            mat.dispose();
            const t = (mat.uniforms.uTex.value as THREE.Texture | null);
            if (t) t.dispose();
        };
    }, [engineReady]);

    useEffect(() => {
        if (!engineReady) return;
        const mesh = meshRef.current;
        if (!mesh) return;

        const mat = mesh.material as THREE.ShaderMaterial;

        // --- initial sync from store ---
        {
            const s = useControls.getState();
            mesh.visible = s.layers.evaporation;

            mat.uniforms.uEvapMin.value = s.evap.uEvapMin;
            mat.uniforms.uEvapMax.value = s.evap.uEvapMax;
            mat.uniforms.uThreshold.value = s.evap.uThreshold;
            mat.uniforms.uGamma.value = s.evap.uGamma;
            mat.uniforms.uAlphaScale.value = s.evap.uAlphaScale;
        }

        // --- subscribe: visibility ---
        const unsubVis = useControls.subscribe(
            (st) => st.layers.evaporation,
            (v) => {
                mesh.visible = v;
            }
        );

        // --- subscribe: evap params ---
        const unsubParams = useControls.subscribe(
            (st) => st.evap,
            (p) => {
                mat.uniforms.uEvapMin.value = p.uEvapMin;
                mat.uniforms.uEvapMax.value = p.uEvapMax;
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


    // update on timestamp: load new png as texture and set uniform
    useEffect(() => {
        if (!engineReady) return;
        const mesh = meshRef.current;
        if (!mesh) return;

        let cancelled = false;
        const mat = mesh.material as THREE.ShaderMaterial;

        const url = moistureTransportApiUrl(timestamp);

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
