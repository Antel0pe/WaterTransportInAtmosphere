// MoistureTransportLayer.tsx (client component)
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { totalColumnWaterApiUrl } from "../utils/ApiResponses";
import { useControls } from "../../state/controlsStore";
import {
  animateUniform,
  configureDataTexture,
  crossfadeTextureUniforms,
  disposeCrossfadeTextures,
  loadDataTextureFromApi,
} from "./shaderUtils";

type MoistureParams = ReturnType<typeof useControls.getState>["moisture"];

function applyMoistureParams(mat: THREE.ShaderMaterial, p: MoistureParams) {
  mat.uniforms.uAnomMin.value = p.uAnomMin;
  mat.uniforms.uAnomMax.value = p.uAnomMax;
  mat.uniforms.uThreshold.value = p.uThreshold;
  mat.uniforms.uGamma.value = p.uGamma;
}

export default function MoistureTransportLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("moisture-transport");
  const enabled = useControls((st) => st.layers.moisture);

  const meshRef = useRef<THREE.Mesh | null>(null);
  const reqIdRef = useRef(0);
  const pendingRef = useRef<MoistureParams | null>(null);
  const hasContentRef = useRef(false);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;

    const R = 100;
    const LIFT = R * 0.002;
    const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

    const s = useControls.getState();
    pendingRef.current = s.moisture;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uTexA: { value: null as THREE.Texture | null },
        uTexB: { value: null as THREE.Texture | null },
        uMix: { value: 0.0 },
        uLonOffset: { value: 0.25 },
        uAnomMin: { value: s.moisture.uAnomMin },
        uAnomMax: { value: s.moisture.uAnomMax },
        uThreshold: { value: s.moisture.uThreshold },
        uGamma: { value: s.moisture.uGamma },
        uLayerOpacity: { value: 1.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uMix;
uniform float uLonOffset;

uniform float uAnomMin;
uniform float uAnomMax;

uniform float uThreshold;
uniform float uGamma;
uniform float uLayerOpacity;

varying vec2 vUv;

void main() {
  vec2 uv = vUv;
  uv.x = fract(uv.x + uLonOffset);

  float cA = texture2D(uTexA, uv).b;
  float cB = texture2D(uTexB, uv).b;
  float c = mix(cA, cB, clamp(uMix, 0.0, 1.0));
  float anom = mix(uAnomMin, uAnomMax, c);

  if (anom <= uThreshold) discard;

  float t = clamp((anom - uThreshold) / (uAnomMax - uThreshold), 0.0, 1.0);
  t = pow(t, uGamma);

  vec3 deep = vec3(0.20, 0.00, 0.35);
  vec3 mid  = vec3(0.85, 0.20, 1.00);
  vec3 hot  = vec3(1.00, 0.78, 1.00);

  vec3 col = mix(deep, mid, smoothstep(0.15, 0.60, t));
  col = mix(col, hot, smoothstep(0.65, 1.00, t));

  float alpha = smoothstep(0.05, 0.15, t) * clamp(uLayerOpacity, 0.0, 1.0);

  gl_FragColor = vec4(col, alpha);
}
`,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "moisture-transport-layer";
    mesh.renderOrder = 50;
    mesh.frustumCulled = false;
    mesh.visible = s.layers.moisture && hasContentRef.current;

    scene.add(mesh);
    meshRef.current = mesh;

    return () => {
      meshRef.current = null;

      mesh.removeFromParent();
      geom.dispose();

      disposeCrossfadeTextures(mat);
      mat.dispose();
    };
  }, [engineReady, globeRef, sceneRef]);

  useEffect(() => {
    if (!engineReady) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    pendingRef.current = useControls.getState().moisture;

    const unsubVis = useControls.subscribe(
      (st) => st.layers.moisture,
      (v) => {
        mesh.visible = v && hasContentRef.current;
      }
    );

    const unsubParams = useControls.subscribe(
      (st) => st.moisture,
      (p) => {
        pendingRef.current = p;
        applyMoistureParams(mesh.material as THREE.ShaderMaterial, p);
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

    const mat = mesh.material as THREE.ShaderMaterial;

    let cancelled = false;
    const myReqId = ++reqIdRef.current;
    const isCancelled = () => cancelled || myReqId !== reqIdRef.current;

    if (!enabled) {
      hasContentRef.current = false;
      mesh.visible = false;
      disposeCrossfadeTextures(mat);
      mat.uniforms.uTexA.value = null;
      mat.uniforms.uTexB.value = null;
      mat.uniforms.uMix.value = 0.0;
      mat.uniforms.uLayerOpacity.value = 0.0;
      mat.needsUpdate = true;
      signalReady(timestamp);
      return () => {
        cancelled = true;
      };
    }

    mesh.visible = hasContentRef.current;

    const url = totalColumnWaterApiUrl(timestamp);

    void loadDataTextureFromApi({
      url,
      fallbackMessage: "Failed to load moisture data.",
      layerLabel: "Total column water layer",
    })
      .then((tex) => {
        if (isCancelled()) {
          tex.dispose();
          return;
        }

        configureDataTexture(tex);

        const latest = pendingRef.current ?? useControls.getState().moisture;
        applyMoistureParams(mat, latest);

        const hadVisibleContent = hasContentRef.current;
        hasContentRef.current = true;
        mesh.visible = true;

        if (!hadVisibleContent) {
          disposeCrossfadeTextures(mat);
          mat.uniforms.uTexA.value = tex;
          mat.uniforms.uTexB.value = tex;
          mat.uniforms.uMix.value = 0.0;
          mat.uniforms.uLayerOpacity.value = 0.0;
          mat.needsUpdate = true;

          animateUniform(mat, "uLayerOpacity", 0.0, 1.0, 220, isCancelled);
          signalReady(timestamp);
          return;
        }

        mat.uniforms.uLayerOpacity.value = 1.0;
        crossfadeTextureUniforms({
          material: mat,
          nextTexture: tex,
          isCancelled,
        });
        signalReady(timestamp);
      })
      .catch((err) => {
        if (isCancelled()) return;
        console.error("Failed to load moisture png", err);
        if (!hasContentRef.current) {
          mesh.visible = false;
        }
        signalReady(timestamp);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, engineReady, timestamp, signalReady]);

  return null;
}
