// EvaporationLayer.tsx
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { evaporationApiUrl } from "../utils/ApiResponses";
import { useControls } from "../../state/controlsStore";
import { configureDataTexture } from "./shaderUtils";

type EvapParams = ReturnType<typeof useControls.getState>["evap"];

function applyEvapParams(mat: THREE.ShaderMaterial, p: EvapParams) {
  mat.uniforms.uAnomMin.value = p.uEvapMin;
  mat.uniforms.uAnomMax.value = p.uEvapMax;
  mat.uniforms.uThreshold.value = p.uThreshold;
  mat.uniforms.uGamma.value = p.uGamma;
  mat.uniforms.uAlphaScale.value = p.uAlphaScale;
}

function animateFade(
  ms: number,
  isCancelled: () => boolean,
  onUpdate: (t: number) => void,
  onDone?: () => void
) {
  const start = performance.now();
  function step(now: number) {
    if (isCancelled()) return;
    const t = Math.min(1, (now - start) / Math.max(ms, 1));
    onUpdate(t);
    if (t < 1) requestAnimationFrame(step);
    else onDone?.();
  }
  requestAnimationFrame(step);
}

export default function EvaporationLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("evaporation");

  const meshARef = useRef<THREE.Mesh | null>(null);
  const meshBRef = useRef<THREE.Mesh | null>(null);

  const activeRef = useRef<"A" | "B">("A");
  const reqIdRef = useRef(0);
  const pendingRef = useRef<EvapParams | null>(null);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;

    const R = 100;
    const LIFT = R * 0.002;
    const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

    const s = useControls.getState();
    pendingRef.current = s.evap;

    const makeMaterial = () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        uniforms: {
          uTex: { value: null as THREE.Texture | null },
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
          uniform sampler2D uTex;
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

            float b01 = texture2D(uTex, uv).b;
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

    const matA = makeMaterial();
    const matB = makeMaterial();

    const meshA = new THREE.Mesh(geom, matA);
    meshA.name = "evaporation-anomaly-layer-A";
    meshA.renderOrder = 50;
    meshA.frustumCulled = false;

    const meshB = new THREE.Mesh(geom, matB);
    meshB.name = "evaporation-anomaly-layer-B";
    meshB.renderOrder = 50;
    meshB.frustumCulled = false;

    matB.uniforms.uLayerOpacity.value = 0.0;

    meshA.visible = s.layers.evaporation;
    meshB.visible = s.layers.evaporation;

    scene.add(meshA);
    scene.add(meshB);

    meshARef.current = meshA;
    meshBRef.current = meshB;
    activeRef.current = "A";

    return () => {
      meshARef.current = null;
      meshBRef.current = null;

      meshA.removeFromParent();
      meshB.removeFromParent();
      geom.dispose();

      for (const mesh of [meshA, meshB]) {
        const mat = mesh.material as THREE.ShaderMaterial;
        const tex = mat.uniforms.uTex.value as THREE.Texture | null;
        if (tex) tex.dispose();
        mat.dispose();
      }
    };
  }, [engineReady, globeRef, sceneRef]);

  useEffect(() => {
    if (!engineReady) return;
    const meshA = meshARef.current;
    const meshB = meshBRef.current;
    if (!meshA || !meshB) return;

    pendingRef.current = useControls.getState().evap;

    const unsubVis = useControls.subscribe(
      (st) => st.layers.evaporation,
      (v) => {
        meshA.visible = v;
        meshB.visible = v;
      }
    );

    const unsubParams = useControls.subscribe(
      (st) => st.evap,
      (p) => {
        pendingRef.current = p;
      }
    );

    return () => {
      unsubVis();
      unsubParams();
    };
  }, [engineReady]);

  useEffect(() => {
    if (!engineReady) return;
    const meshA = meshARef.current;
    const meshB = meshBRef.current;
    if (!meshA || !meshB) return;

    let cancelled = false;
    const myReqId = ++reqIdRef.current;
    const isCancelled = () => cancelled || myReqId !== reqIdRef.current;

    if (!useControls.getState().layers.evaporation) {
      meshA.visible = false;
      meshB.visible = false;
      signalReady(timestamp);
      return () => {
        cancelled = true;
      };
    }

    meshA.visible = true;
    meshB.visible = true;

    const activeKey = activeRef.current;
    const activeMesh = activeKey === "A" ? meshA : meshB;
    const nextMesh = activeKey === "A" ? meshB : meshA;

    const activeMat = activeMesh.material as THREE.ShaderMaterial;
    const nextMat = nextMesh.material as THREE.ShaderMaterial;

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
        applyEvapParams(nextMat, latest);

        const prevNextTex = nextMat.uniforms.uTex.value as THREE.Texture | null;
        nextMat.uniforms.uTex.value = tex;
        nextMat.needsUpdate = true;
        if (prevNextTex) prevNextTex.dispose();

        nextMat.uniforms.uLayerOpacity.value = 0.0;
        activeMat.uniforms.uLayerOpacity.value = 1.0;

        const FADE_MS = 220;

        animateFade(
          FADE_MS,
          isCancelled,
          (t) => {
            activeMat.uniforms.uLayerOpacity.value = 1.0 - t;
            nextMat.uniforms.uLayerOpacity.value = t;
          },
          () => {
            if (isCancelled()) return;

            activeRef.current = activeKey === "A" ? "B" : "A";
            activeMat.uniforms.uLayerOpacity.value = 0.0;
            nextMat.uniforms.uLayerOpacity.value = 1.0;
          }
        );

        signalReady(timestamp);
      },
      undefined,
      (err) => {
        if (isCancelled()) return;
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
