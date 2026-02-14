// MoistureTransportLayer.tsx (client component)
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { moistureTransportApiUrl, totalColumnWaterApiUrl } from "../utils/ApiResponses";


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
                uTex: { value: null },
                uLonOffset: { value: 0.5 },      // if you rolled lon in python by half
                uAnomMin: { value: -50.0 },
                uAnomMax: { value: 50.0 },
                uThreshold: { value: 10.0 },      // start with 5–10
                uGamma: { value: 1.0 },
            },

            vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `, fragmentShader: `
uniform sampler2D uTex;
uniform float uLonOffset;

// your encoding params
uniform float uAnomMin;   // -50.0
uniform float uAnomMax;   //  50.0

uniform float uThreshold; // e.g. 5.0 means hide |anom| < 5
uniform float uGamma;     // e.g. 1.0..2.0

varying vec2 vUv;

void main() {
vec2 uv = vUv;
uv.x = fract(uv.x + uLonOffset);

float c = texture2D(uTex, uv).b; // 0..1

// decode blue channel back to anomaly units (e.g. kg/m^2)
float anom = mix(uAnomMin, uAnomMax, c);

// only keep positive anomalies above threshold
if (anom <= uThreshold) discard;

// normalize anomaly to 0..1 for intensity/alpha
float t = clamp((anom - uThreshold) / (uAnomMax - uThreshold), 0.5, 1.0);
t = pow(t, uGamma);  // optional shaping

// gl_FragColor = vec4(texture2D(uTex, uv).r, texture2D(uTex, uv).g, texture2D(uTex, uv).b, 1.0);
gl_FragColor = vec4(c, 0.0, 0.0, t);

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
        // const url = moistureTransportApiUrl(timestamp);
        const url = totalColumnWaterApiUrl(timestamp);

        new THREE.TextureLoader().load(
            url,
            (tex) => {
                if (cancelled) {
                    tex.dispose();
                    return;
                }

                // optional: depends on your png encoding; if it looks washed/too dark, tweak/remove
                // tex.colorSpace = THREE.SRGBColorSpace;
                tex.colorSpace = THREE.NoColorSpace; // TO DO CHECK THIS PROPERLY

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
    }, [engineReady, timestamp]);

    return null;
}
