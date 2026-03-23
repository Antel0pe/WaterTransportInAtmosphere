// IVTLayer.tsx (client component)
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { ivtApiUrl } from "../utils/ApiResponses";
import { useControls } from "../../state/controlsStore";
import {
  animateUniform,
  configureDataTexture,
  crossfadeTextureUniforms,
  disposeCrossfadeTextures,
} from "./shaderUtils";

type IVTParams = ReturnType<typeof useControls.getState>["ivt"];

function applyIVTParams(mat: THREE.ShaderMaterial, p: IVTParams) {
  mat.uniforms.uMin.value = p.uIvtMin;
  mat.uniforms.uMax.value = p.uIvtMax;
  mat.uniforms.uScale.value = p.uScale;
  mat.uniforms.uGamma.value = p.uGamma;
}

export default function IVTLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("ivt");
  const enabled = useControls((st) => st.layers.ivt);

  const meshRef = useRef<THREE.Mesh | null>(null);
  const reqIdRef = useRef(0);
  const pendingRef = useRef<IVTParams | null>(null);
  const hasContentRef = useRef(false);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;

    const R = 100;
    const LIFT = R * 0.002;
    const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

    const s = useControls.getState();
    pendingRef.current = s.ivt;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uTexA: { value: null as THREE.Texture | null },
        uTexB: { value: null as THREE.Texture | null },
        uMix: { value: 0.0 },
        uLonOffset: { value: 0.25 },
        uMin: { value: s.ivt.uIvtMin },
        uMax: { value: s.ivt.uIvtMax },
        uScale: { value: s.ivt.uScale },
        uGamma: { value: s.ivt.uGamma },
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

uniform float uMin;
uniform float uMax;

uniform float uScale;
uniform float uGamma;
uniform float uLayerOpacity;

varying vec2 vUv;

float hash12(vec2 p){
  vec3 p3  = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vUv;
  uv.x = fract(uv.x + uLonOffset);

  vec4 texA = texture2D(uTexA, uv);
  vec4 texB = texture2D(uTexB, uv);
  vec4 tex = mix(texA, texB, clamp(uMix, 0.0, 1.0));

  float ivt1000 = mix(uMin, uMax, tex.r);
  float ivt925  = mix(uMin, uMax, tex.b);
  float sumIvt = ivt1000 + ivt925;

  float denom = max(2.0 * (uMax - uMin), 1e-9);
  float t = clamp((sumIvt - 2.0*uMin) / denom, 0.0, 1.0);

  t = clamp(t * uScale, 0.0, 1.0);
  t = pow(t, uGamma);

  vec3 col = vec3(0.0, t, 0.0);
  col.g += (hash12(gl_FragCoord.xy) - 0.5) * 0.01;

  float alpha = smoothstep(0.02, 0.25, t) * clamp(uLayerOpacity, 0.0, 1.0);

  gl_FragColor = vec4(col, alpha);
}
      `,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "ivt-layer";
    mesh.renderOrder = 51;
    mesh.frustumCulled = false;
    mesh.visible = s.layers.ivt && hasContentRef.current;

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

    pendingRef.current = useControls.getState().ivt;

    const unsubVis = useControls.subscribe(
      (st) => st.layers.ivt,
      (v) => {
        mesh.visible = v && hasContentRef.current;
      }
    );

    const unsubParams = useControls.subscribe(
      (st) => st.ivt,
      (p) => {
        pendingRef.current = p;
        applyIVTParams(mesh.material as THREE.ShaderMaterial, p);
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

    const url = ivtApiUrl(timestamp);

    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (isCancelled()) {
          tex.dispose();
          return;
        }

        configureDataTexture(tex);

        const latest = pendingRef.current ?? useControls.getState().ivt;
        applyIVTParams(mat, latest);

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
        console.error("Failed to load ivt png", err);
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
