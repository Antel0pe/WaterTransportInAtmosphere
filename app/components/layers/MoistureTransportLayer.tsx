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
                uChannel: { value: 2 }, // 0=R, 1=G, 2=B (default B)
                uLonOffset: { value: 0.25 }, 

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
uniform int uChannel;      // 0=R, 1=G, 2=B
uniform float uLonOffset;  // 0..1 (0.5 = 180° shift)
varying vec2 vUv;

float pickChannel(vec3 rgb, int ch) {
  if (ch == 0) return rgb.r;
  if (ch == 1) return rgb.g;
  return rgb.b;
}

void main() {
  // wrap longitude shift in shader (works even if texture is clamped)
  vec2 uv = vUv;
  uv.x = fract(uv.x + uLonOffset);

  vec4 tex = texture2D(uTex, uv);

  float c = pickChannel(tex.rgb, uChannel);

  // decode example (your old encoding): value in [0..110]
  float tcw = c * 110.0;

  // cap at 70
  float t = clamp(tcw / 70.0, 0.0, 1.0);

  // linear dark-red -> bright-red + alpha
  float base = 1.0;
  float r = mix(base, 1.0, t);
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
                tex.flipY = true; 
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.offset.x = 0.5;


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
