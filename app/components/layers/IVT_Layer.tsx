// IVTLayer.tsx (client component)
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { ivtApiUrl } from "../utils/ApiResponses";
import { useControls } from "../../state/controlsStore";

export default function IVTLayer() {
    const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
        useEarthLayer("ivt");

    const meshRef = useRef<THREE.Mesh | null>(null);

    // init once
    useEffect(() => {
        if (!engineReady) return;
        if (!sceneRef.current || !globeRef.current) return;

        const scene = sceneRef.current;

        const R = 100;
        const LIFT = R * 0.002;
        const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

        // single source of truth: store defaults
        const s = useControls.getState();

        const mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            uniforms: {
                uTex: { value: null as THREE.Texture | null },
                uLonOffset: { value: 0.25 },

                // min/max come from the store (hook defaults)
                uMin: { value: s.ivt.uIvtMin },
                uMax: { value: s.ivt.uIvtMax },
                uScale: { value: s.ivt.uScale },
                uGamma: { value: s.ivt.uGamma },

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

        uniform float uMin;
        uniform float uMax;

        uniform float uScale;
        uniform float uGamma;

        varying vec2 vUv;

        float hash12(vec2 p){
          vec3 p3  = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
          vec2 uv = vUv;
          uv.x = fract(uv.x + uLonOffset);

          vec4 tex = texture2D(uTex, uv);

          // r = 1000 hPa, b = 925 hPa (both encoded 0..1 from uMin..uMax)
          float ivt1000 = mix(uMin, uMax, tex.r);
          float ivt925  = mix(uMin, uMax, tex.b);
          float sumIvt = ivt1000 + ivt925;

          // Normalize sum from [2*uMin .. 2*uMax] -> [0..1]
          float denom = max(2.0 * (uMax - uMin), 1e-9);
          float t = clamp((sumIvt - 2.0*uMin) / denom, 0.0, 1.0);

          // scale + gamma
          t = clamp(t * uScale, 0.0, 1.0);
          t = pow(t, uGamma);

          // pure green
          vec3 col = vec3(0.0, t, 0.0);

          // tiny dithering to reduce banding
          col.g += (hash12(gl_FragCoord.xy) - 0.5) * 0.01;

          float alpha = smoothstep(0.02, 0.25, t);

          gl_FragColor = vec4(col, alpha);
        }
      `,
        });

        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = "ivt-layer";
        mesh.renderOrder = 51;
        mesh.frustumCulled = false;

        mesh.visible = s.layers.ivt;

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

    // subscribe: visibility + params
    useEffect(() => {
        if (!engineReady) return;
        const mesh = meshRef.current;
        if (!mesh) return;

        const mat = mesh.material as THREE.ShaderMaterial;

        const unsubVis = useControls.subscribe(
            (st) => st.layers.ivt,
            (v) => {
                mesh.visible = v;
            }
        );

        const unsubParams = useControls.subscribe(
            (st) => st.ivt,
            (p) => {
                mat.uniforms.uMin.value = p.uIvtMin;
                mat.uniforms.uMax.value = p.uIvtMax;
                mat.uniforms.uScale.value = p.uScale;
                mat.uniforms.uGamma.value = p.uGamma;
            }
        );


        return () => {
            unsubVis();
            unsubParams();
        };
    }, [engineReady]);

    // update on timestamp: load new png as texture
    useEffect(() => {
        if (!engineReady) return;
        const mesh = meshRef.current;
        if (!mesh) return;

        let cancelled = false;

        const mat = mesh.material as THREE.ShaderMaterial;
        const url = ivtApiUrl(timestamp);

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
                console.error("Failed to load ivt png", err);
                signalReady(timestamp);
            }
        );

        return () => {
            cancelled = true;
        };
    }, [engineReady, timestamp, signalReady]);

    return null;
}
