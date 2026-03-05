// IVTLayer.tsx (client component)
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { ivtApiUrl } from "../utils/ApiResponses";
import { useControls } from "../../state/controlsStore";
import { configureDataTexture } from "./shaderUtils";

type IVTParams = ReturnType<typeof useControls.getState>["ivt"];

function applyIVTParams(mat: THREE.ShaderMaterial, p: IVTParams) {
  mat.uniforms.uMin.value = p.uIvtMin;
  mat.uniforms.uMax.value = p.uIvtMax;
  mat.uniforms.uScale.value = p.uScale;
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

export default function IVTLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("ivt");

  const meshARef = useRef<THREE.Mesh | null>(null);
  const meshBRef = useRef<THREE.Mesh | null>(null);

  const activeRef = useRef<"A" | "B">("A");
  const reqIdRef = useRef(0);
  const pendingRef = useRef<IVTParams | null>(null);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;

    const R = 100;
    const LIFT = R * 0.002;
    const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

    const s = useControls.getState();
    pendingRef.current = s.ivt;

    const makeMaterial = () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        uniforms: {
          uTex: { value: null as THREE.Texture | null },
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
          uniform sampler2D uTex;
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

            vec4 tex = texture2D(uTex, uv);

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

    const matA = makeMaterial();
    const matB = makeMaterial();

    const meshA = new THREE.Mesh(geom, matA);
    meshA.name = "ivt-layer-A";
    meshA.renderOrder = 51;
    meshA.frustumCulled = false;

    const meshB = new THREE.Mesh(geom, matB);
    meshB.name = "ivt-layer-B";
    meshB.renderOrder = 51;
    meshB.frustumCulled = false;

    matB.uniforms.uLayerOpacity.value = 0.0;

    meshA.visible = s.layers.ivt;
    meshB.visible = s.layers.ivt;

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

    pendingRef.current = useControls.getState().ivt;

    const unsubVis = useControls.subscribe(
      (st) => st.layers.ivt,
      (v) => {
        meshA.visible = v;
        meshB.visible = v;
      }
    );

    const unsubParams = useControls.subscribe(
      (st) => st.ivt,
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

    if (!useControls.getState().layers.ivt) {
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
        applyIVTParams(nextMat, latest);

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
