// EvaporationLayer.tsx
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { evaporationApiUrl } from "../utils/ApiResponses";
import { useControls } from "../../state/controlsStore";
import {
  animateUniform,
  configureDataTexture,
  crossfadeTextureUniforms,
  disposeCrossfadeTextures,
} from "./shaderUtils";

type EvapParams = ReturnType<typeof useControls.getState>["evap"];

function applyEvapParams(mat: THREE.ShaderMaterial, p: EvapParams) {
  mat.uniforms.uAnomMin.value = p.uEvapMin;
  mat.uniforms.uAnomMax.value = p.uEvapMax;
  mat.uniforms.uThreshold.value = p.uThreshold;
  mat.uniforms.uGamma.value = p.uGamma;
  mat.uniforms.uAlphaScale.value = p.uAlphaScale;
}

export default function EvaporationLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("evaporation");
  const enabled = useControls((st) => st.layers.evaporation);

  const meshRef = useRef<THREE.Mesh | null>(null);
  const reqIdRef = useRef(0);
  const pendingRef = useRef<EvapParams | null>(null);
  const hasContentRef = useRef(false);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;

    const R = 100;
    const LIFT = R * 0.002;
    const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

    const s = useControls.getState();
    pendingRef.current = s.evap;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uTexA: { value: null as THREE.Texture | null },
        uTexB: { value: null as THREE.Texture | null },
        uMix: { value: 0.0 },
        uLonOffset: { value: 0.25 },
        uAnomMin: { value: s.evap.uEvapMin },
        uAnomMax: { value: s.evap.uEvapMax },
        uThreshold: { value: s.evap.uThreshold },
        uGamma: { value: s.evap.uGamma },
        uAlphaScale: { value: s.evap.uAlphaScale },
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
uniform float uAlphaScale;
uniform float uLayerOpacity;

varying vec2 vUv;

void main() {
  vec2 uv = vUv;
  uv.x = fract(uv.x + uLonOffset);

  float b01A = texture2D(uTexA, uv).b;
  float b01B = texture2D(uTexB, uv).b;
  float b01 = mix(b01A, b01B, clamp(uMix, 0.0, 1.0));
  float anom = mix(uAnomMin, uAnomMax, b01);

  if (anom <= uThreshold) discard;

  float t = (anom - uThreshold) / max(uAnomMax - uThreshold, 1e-12);
  t = clamp(t, 0.0, 1.0);
  t = pow(t, uGamma);

  vec3 col = vec3(t, 0.0, 0.0);
  float alpha = clamp(t * uAlphaScale, 0.0, 1.0);
  alpha *= clamp(uLayerOpacity, 0.0, 1.0);

  gl_FragColor = vec4(col, alpha);
}
      `,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "evaporation-anomaly-layer";
    mesh.renderOrder = 50;
    mesh.frustumCulled = false;
    mesh.visible = s.layers.evaporation && hasContentRef.current;

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

    pendingRef.current = useControls.getState().evap;

    const unsubVis = useControls.subscribe(
      (st) => st.layers.evaporation,
      (v) => {
        mesh.visible = v && hasContentRef.current;
      }
    );

    const unsubParams = useControls.subscribe(
      (st) => st.evap,
      (p) => {
        pendingRef.current = p;
        applyEvapParams(mesh.material as THREE.ShaderMaterial, p);
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

    const url = evaporationApiUrl(timestamp);

    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (isCancelled()) {
          tex.dispose();
          return;
        }

        configureDataTexture(tex);

        const latest = pendingRef.current ?? useControls.getState().evap;
        applyEvapParams(mat, latest);

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
      },
      undefined,
      (err) => {
        if (isCancelled()) return;
        console.error("Failed to load evaporation png", err);
        if (!hasContentRef.current) {
          mesh.visible = false;
        }
        signalReady(timestamp);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [enabled, engineReady, timestamp, signalReady]);

  return null;
}
