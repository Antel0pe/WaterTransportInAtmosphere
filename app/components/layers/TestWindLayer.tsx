// WindUv925Layer.tsx (client component)
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { windUvRgApiUrl } from "../utils/ApiResponses";

export default function TestWindLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("wind-uv-925");

  const meshRef = useRef<THREE.Mesh | null>(null);

  // these MUST match export_uv_925_rgb.py
  const UV_MIN = -40.0;
  const UV_MAX = 40.0;

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
        uLonOffset: { value: 0.25 }, // same convention as your other layers

        // decode params (match python export scaling)
        uUvMin: { value: UV_MIN },
        uUvMax: { value: UV_MAX },
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
        uniform float uUvMin;
        uniform float uUvMax;

        varying vec2 vUv;

        // PNG channels arrive normalized to 0..1 in the shader.
        // Your python saved uint8 where:
        //   r8 = (u - UV_MIN) * 255/(UV_MAX-UV_MIN) clipped
        // so decoding is:
        //   u = mix(UV_MIN, UV_MAX, tex.r)
        vec2 decodeUV(vec2 rg01) {
          float u = mix(uUvMin, uUvMax, rg01.r);
          float v = mix(uUvMin, uUvMax, rg01.g);
          return vec2(u, v);
        }

        void main() {
        //   if (uTex == NULL) discard;

          vec2 uv = vUv;
          uv.x = fract(uv.x + uLonOffset);

          vec4 texel = texture2D(uTex, uv);
          vec2 wind = decodeUV(texel.rg);

          // Display:
          // Re-encode u and v back to 0..1 (same mapping as python) and show as RG.
          // This makes the screen show exactly what’s inside the PNG, but "proved" via decode->encode.
          vec2 rg01 = (wind - vec2(uUvMin)) / (uUvMax - uUvMin);

          // optional: add speed into B so you can see magnitude at a glance
          float speed = length(wind);
          float b = clamp(speed / uUvMax, 0.0, 1.0);

          gl_FragColor = vec4(rg01.r, rg01.g, b, 1.0);
          gl_FragColor = vec4(0.0, 0.0, b, 1.0);
        // gl_FragColor = vec4(texel);
        }
      `,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "wind-uv-925-layer";
    mesh.renderOrder = 55; // draw after moisture (50)
    mesh.frustumCulled = false;
    mesh.visible = true;

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

  // update on timestamp: load new png as texture and set uniform
  useEffect(() => {
    if (!engineReady) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    let cancelled = false;

    const mat = mesh.material as THREE.ShaderMaterial;
    const url = windUvRgApiUrl(timestamp, 250);

    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (cancelled) {
          tex.dispose();
          return;
        }

        tex.colorSpace = THREE.NoColorSpace;
        tex.flipY = true; // keep consistent with your other layer
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
        console.error("Failed to load wind uv 925 png", err);
        signalReady(timestamp);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [engineReady, timestamp, signalReady]);

  return null;
}