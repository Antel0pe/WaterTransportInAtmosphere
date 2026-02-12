// MoistureTransportLayer.tsx (client component)
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { moistureTransportApiUrl } from "../utils/ApiResponses";


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

        const mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false, // important for overlay layers
            depthTest: true,
            uniforms: {
                uTex: { value: null as THREE.Texture | null },
                uStrength: { value: 2.0 },
                uThreshold: { value: 0.0 }, // e.g. 1.0 or 2.0 if you want to suppress noise
                uGamma: { value: 1.0 },     // e.g. 1.2 makes only higher TCW pop more
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
  varying vec2 vUv;

  void main() {
    vec4 tex = texture2D(uTex, vUv);

    // undo your encoding: tcw = tex.b * 110
    float tcw = tex.b * 110.0;

    // cap at 70 (everything >= 70 maps to max)
    float t = clamp(tcw / 70.0, 0.0, 1.0);

    // purely linear dark-red -> bright-red
    float base = 1.0;               // set >0.0 if you want a non-black "dark red"
    float r = mix(base, 1.0, t);

    // linear alpha too (or set to a constant if you want a fully visible layer)
    float a = t;

    gl_FragColor = vec4(r, 0.0, 0.0, a);
  }
`,


        });

        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = "moisture-transport-layer";
        mesh.renderOrder = 50; // draw after earth
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

                // optional: depends on your png encoding; if it looks washed/too dark, tweak/remove
                tex.colorSpace = THREE.SRGBColorSpace;

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
    }, [engineReady, timestamp]);

    return null;
}
