import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { verticalVelocityApiUrl } from "../utils/ApiResponses";
import { VerticalVelocityPressure, useControls } from "../../state/controlsStore";
import {
  animateUniform,
  configureDataTexture,
  crossfadeTextureUniforms,
  disposeCrossfadeTextures,
  loadDataTextureFromApi,
} from "./shaderUtils";

const SUPPORTED_LEVELS = [250, 500, 925] as const;
type SupportedLevel = (typeof SUPPORTED_LEVELS)[number];
type DataRange = { min: number; max: number };

function defaultRangeForLevel(level: SupportedLevel): DataRange {
  if (level === 250) return { min: -12.417227745056152, max: 4.784543991088867 };
  if (level === 500) return { min: -19.965789794921875, max: 9.565109252929688 };
  return { min: -8.456122398376465, max: 9.214824676513672 };
}

function resolveLevel(pressure: VerticalVelocityPressure): SupportedLevel | null {
  if (pressure === "none") return null;
  return SUPPORTED_LEVELS.includes(pressure) ? pressure : 250;
}

type VerticalVelocityParams = ReturnType<typeof useControls.getState>["verticalVelocity"];

function applyVerticalVelocityDisplayParams(
  mat: THREE.ShaderMaterial,
  p: VerticalVelocityParams
) {
  mat.uniforms.uDisplayMin.value = p.uWMin;
  mat.uniforms.uDisplayMax.value = p.uWMax;
  mat.uniforms.uGamma.value = p.uGamma;
  mat.uniforms.uAlpha.value = p.uAlpha;
  mat.uniforms.uZeroEps.value = p.uZeroEps;
  mat.uniforms.uAsinhK.value = p.uAsinhK;
}

function applyVerticalVelocityDecodeRange(
  mat: THREE.ShaderMaterial,
  slot: "A" | "B",
  range: DataRange
) {
  if (slot === "A") {
    mat.uniforms.uDataMinA.value = range.min;
    mat.uniforms.uDataMaxA.value = range.max;
    return;
  }

  mat.uniforms.uDataMinB.value = range.min;
  mat.uniforms.uDataMaxB.value = range.max;
}

export default function VerticalVelocityLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("vertical-velocity");

  const pressureLevel = useControls((st) => st.verticalVelocity.pressureLevel);

  const meshRef = useRef<THREE.Mesh | null>(null);
  const reqIdRef = useRef(0);
  const pendingRef = useRef<VerticalVelocityParams | null>(null);
  const hasContentRef = useRef(false);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;
    const s = useControls.getState();
    pendingRef.current = s.verticalVelocity;

    const R = 100;
    const LIFT = R * 0.0026;
    const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uTexA: { value: null as THREE.Texture | null },
        uTexB: { value: null as THREE.Texture | null },
        uMix: { value: 0.0 },
        uLonOffset: { value: 0.25 },
        uDataMinA: { value: 0 },
        uDataMaxA: { value: 1 },
        uDataMinB: { value: 0 },
        uDataMaxB: { value: 1 },
        uDisplayMin: { value: s.verticalVelocity.uWMin },
        uDisplayMax: { value: s.verticalVelocity.uWMax },
        uGamma: { value: s.verticalVelocity.uGamma },
        uAlpha: { value: s.verticalVelocity.uAlpha },
        uZeroEps: { value: s.verticalVelocity.uZeroEps },
        uAsinhK: { value: s.verticalVelocity.uAsinhK },
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
uniform float uDataMinA;
uniform float uDataMaxA;
uniform float uDataMinB;
uniform float uDataMaxB;

uniform float uDisplayMin;
uniform float uDisplayMax;

uniform float uGamma;
uniform float uAlpha;
uniform float uZeroEps;
uniform float uLayerOpacity;

varying vec2 vUv;

vec3 WARM = vec3(1.00, 0.08, 0.08);
vec3 COOL = vec3(0.10, 0.80, 0.72);
vec3 NEU  = vec3(0.86, 0.90, 1.00);

float saturateFast(float m) {
  m = clamp(m, 0.0, 1.0);
  float p = 3.0;
  return 1.0 - pow(1.0 - m, p);
}

void main() {
  vec2 uv = vUv;
  uv.x = fract(uv.x + uLonOffset);

  float xA = texture2D(uTexA, uv).r;
  float xB = texture2D(uTexB, uv).r;
  float valueA = mix(uDataMinA, uDataMaxA, xA);
  float valueB = mix(uDataMinB, uDataMaxB, xB);
  float value = mix(valueA, valueB, clamp(uMix, 0.0, 1.0));

  float v = clamp(value, uDisplayMin, uDisplayMax);

  float scale = max(abs(uDisplayMin), abs(uDisplayMax));
  scale = max(scale, 1e-12);
  float z = clamp(v / scale, -1.0, 1.0);

  float m0 = abs(z);

  float near0 = smoothstep(uZeroEps, uZeroEps * 2.0, m0);

  float m = pow(m0, max(uGamma, 1e-6));

  float s = saturateFast(m);

  vec3 signCol = (z < 0.0) ? WARM : COOL;

  vec3 base = mix(vec3(1.0), signCol, 0.25);
  vec3 col  = mix(base, signCol, s);

  float a = s * near0 * clamp(uAlpha, 0.0, 1.0);
  a *= clamp(uLayerOpacity, 0.0, 1.0);

  gl_FragColor = vec4(col, a);
}
      `,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "vertical-velocity-layer";
    mesh.renderOrder = 58;
    mesh.frustumCulled = false;
    mesh.visible = s.verticalVelocity.pressureLevel !== "none" && hasContentRef.current;

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

    pendingRef.current = useControls.getState().verticalVelocity;

    const unsub = useControls.subscribe(
      (st) => st.verticalVelocity,
      (p) => {
        pendingRef.current = p;
        mesh.visible = p.pressureLevel !== "none" && hasContentRef.current;
        if (hasContentRef.current) {
          applyVerticalVelocityDisplayParams(
            mesh.material as THREE.ShaderMaterial,
            p
          );
        }
      }
    );

    return () => {
      unsub();
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

    const level = resolveLevel(pressureLevel);

    if (level === null) {
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

    const url = verticalVelocityApiUrl(timestamp, level);

    void loadDataTextureFromApi({
      url,
      fallbackMessage: "Failed to load vertical velocity data.",
      layerLabel: `Vertical velocity (${level} hPa)`,
    })
      .then((tex) => {
        if (isCancelled()) {
          tex.dispose();
          return;
        }

        configureDataTexture(tex);

        const latest = pendingRef.current ?? useControls.getState().verticalVelocity;
        const nextRange = defaultRangeForLevel(level);
        applyVerticalVelocityDisplayParams(mat, latest);

        const hadVisibleContent = hasContentRef.current;
        hasContentRef.current = true;
        mesh.visible = true;

        if (!hadVisibleContent) {
          disposeCrossfadeTextures(mat);
          applyVerticalVelocityDecodeRange(mat, "A", nextRange);
          applyVerticalVelocityDecodeRange(mat, "B", nextRange);
          mat.uniforms.uTexA.value = tex;
          mat.uniforms.uTexB.value = tex;
          mat.uniforms.uMix.value = 0.0;
          mat.uniforms.uLayerOpacity.value = 0.0;
          mat.needsUpdate = true;

          animateUniform(mat, "uLayerOpacity", 0.0, 1.0, 220, isCancelled);
          signalReady(timestamp);
          return;
        }

        applyVerticalVelocityDecodeRange(mat, "B", nextRange);
        mat.uniforms.uLayerOpacity.value = 1.0;
        crossfadeTextureUniforms({
          material: mat,
          nextTexture: tex,
          isCancelled,
          onPromote: () => {
            applyVerticalVelocityDecodeRange(mat, "A", nextRange);
            applyVerticalVelocityDecodeRange(mat, "B", nextRange);
          },
        });
        signalReady(timestamp);
      })
      .catch((err) => {
        if (isCancelled()) return;
        console.error("Failed to load vertical velocity png", err);
        if (!hasContentRef.current) {
          mesh.visible = false;
        }
        signalReady(timestamp);
      });

    return () => {
      cancelled = true;
    };
  }, [engineReady, pressureLevel, timestamp, signalReady]);

  return null;
}
