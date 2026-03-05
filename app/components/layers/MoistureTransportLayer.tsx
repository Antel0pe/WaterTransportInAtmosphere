// MoistureTransportLayer.tsx (client component)
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { totalColumnWaterApiUrl } from "../utils/ApiResponses";
import { useControls } from "../../state/controlsStore";
import { configureDataTexture } from "./shaderUtils";

type MoistureParams = ReturnType<typeof useControls.getState>["moisture"];

function applyMoistureParams(mat: THREE.ShaderMaterial, p: MoistureParams) {
  mat.uniforms.uAnomMin.value = p.uAnomMin;
  mat.uniforms.uAnomMax.value = p.uAnomMax;
  mat.uniforms.uThreshold.value = p.uThreshold;
  mat.uniforms.uGamma.value = p.uGamma;
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

export default function MoistureTransportLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("moisture-transport");

  const meshARef = useRef<THREE.Mesh | null>(null);
  const meshBRef = useRef<THREE.Mesh | null>(null);

  const activeRef = useRef<"A" | "B">("A");
  const reqIdRef = useRef(0);
  const pendingRef = useRef<MoistureParams | null>(null);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;

    const R = 100;
    const LIFT = R * 0.002;
    const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

    const s = useControls.getState();
    pendingRef.current = s.moisture;

    const makeMaterial = () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        uniforms: {
          uTex: { value: null as THREE.Texture | null },
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
uniform sampler2D uTex;
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

  float c = texture2D(uTex, uv).b;
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

    const matA = makeMaterial();
    const matB = makeMaterial();

    const meshA = new THREE.Mesh(geom, matA);
    meshA.name = "moisture-transport-layer-A";
    meshA.renderOrder = 50;
    meshA.frustumCulled = false;

    const meshB = new THREE.Mesh(geom, matB);
    meshB.name = "moisture-transport-layer-B";
    meshB.renderOrder = 50;
    meshB.frustumCulled = false;

    matB.uniforms.uLayerOpacity.value = 0.0;

    meshA.visible = s.layers.moisture;
    meshB.visible = s.layers.moisture;

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

    pendingRef.current = useControls.getState().moisture;

    const unsubVis = useControls.subscribe(
      (st) => st.layers.moisture,
      (v) => {
        meshA.visible = v;
        meshB.visible = v;
      }
    );

    const unsubParams = useControls.subscribe(
      (st) => st.moisture,
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

    if (!useControls.getState().layers.moisture) {
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

    const url = totalColumnWaterApiUrl(timestamp);

    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (isCancelled()) {
          tex.dispose();
          return;
        }

        configureDataTexture(tex);

        const latest = pendingRef.current ?? useControls.getState().moisture;
        applyMoistureParams(nextMat, latest);

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
        console.error("Failed to load moisture png", err);
        signalReady(timestamp);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [engineReady, timestamp, signalReady]);

  return null;
}
