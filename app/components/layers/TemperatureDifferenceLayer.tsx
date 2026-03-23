import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { temperatureApiUrl } from "../utils/ApiResponses";
import { TemperatureDiffPressure, useControls } from "../../state/controlsStore";
import {
  animateUniform,
  configureDataTexture,
  DEFAULT_TEXTURE_FADE_MS,
} from "./shaderUtils";

const SUPPORTED_LEVELS = [250, 500, 925] as const;
type SupportedLevel = (typeof SUPPORTED_LEVELS)[number];

const ENCODED_RANGE_BY_LEVEL: Record<SupportedLevel, { min: number; max: number }> = {
  250: { min: 180, max: 330 },
  500: { min: 180, max: 330 },
  925: { min: 180, max: 330 },
};

function defaultRangeForLevel(level: SupportedLevel): { min: number; max: number } {
  return ENCODED_RANGE_BY_LEVEL[level];
}

function resolveLevel(pressure: TemperatureDiffPressure): SupportedLevel | null {
  if (pressure === "none") return null;
  return SUPPORTED_LEVELS.includes(pressure) ? pressure : 250;
}

const MS_PER_HOUR = 3_600_000;

function parseDateTimeUTC(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);

  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day ||
    dt.getUTCHours() !== hour ||
    dt.getUTCMinutes() !== minute
  ) {
    return null;
  }

  return dt;
}

function formatDateTimeUTC(dt: Date): string {
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  const h = String(dt.getUTCHours()).padStart(2, "0");
  const min = String(dt.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${min}`;
}

function oneHourBackTimestamp(timestamp: string): string | null {
  const dt = parseDateTimeUTC(timestamp);
  if (!dt) return null;
  return formatDateTimeUTC(new Date(dt.getTime() - MS_PER_HOUR));
}

type TemperatureDifferenceParams = ReturnType<
  typeof useControls.getState
>["temperatureDifference"];

function applyTemperatureDifferenceDisplayParams(
  mat: THREE.ShaderMaterial,
  p: TemperatureDifferenceParams
) {
  mat.uniforms.uDisplayMin.value = p.uDeltaMin;
  mat.uniforms.uDisplayMax.value = p.uDeltaMax;
  mat.uniforms.uGamma.value = p.uGamma;
  mat.uniforms.uAlpha.value = p.uAlpha;
  mat.uniforms.uContrast.value = p.uContrast;
}

function applyTemperatureDifferenceLoadedLevelParams(
  mat: THREE.ShaderMaterial,
  p: TemperatureDifferenceParams,
  level: SupportedLevel
) {
  const r = defaultRangeForLevel(level);
  mat.uniforms.uDataMin.value = r.min;
  mat.uniforms.uDataMax.value = r.max;
  applyTemperatureDifferenceDisplayParams(mat, p);
}

function loadTexture(loader: THREE.TextureLoader, url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (tex) => resolve(tex),
      undefined,
      (err) => reject(err)
    );
  });
}

async function loadTemperatureTexturePair(args: {
  loader: THREE.TextureLoader;
  currentUrl: string;
  previousUrl: string;
}): Promise<{ currentTex: THREE.Texture; previousTex: THREE.Texture }> {
  const { loader, currentUrl, previousUrl } = args;

  const currentTex = await loadTexture(loader, currentUrl);

  if (previousUrl === currentUrl) {
    return { currentTex, previousTex: currentTex };
  }

  try {
    const previousTex = await loadTexture(loader, previousUrl);
    return { currentTex, previousTex };
  } catch (err) {
    console.warn("Failed to load previous-hour temperature png; falling back to current hour", err);
    return { currentTex, previousTex: currentTex };
  }
}

function getTextureUniform(
  material: THREE.ShaderMaterial,
  uniformName: "uTexCurrentA" | "uTexCurrentB" | "uTexPrevA" | "uTexPrevB"
): { value: THREE.Texture | null } {
  const uniform = (material.uniforms as Record<string, { value: THREE.Texture | null } | undefined>)[uniformName];
  if (!uniform) {
    throw new Error(`Missing shader uniform "${uniformName}"`);
  }
  return uniform;
}

function disposeUniqueTextures(textures: Array<THREE.Texture | null>) {
  const disposed = new Set<THREE.Texture>();
  for (const tex of textures) {
    if (!tex || disposed.has(tex)) continue;
    disposed.add(tex);
    tex.dispose();
  }
}

function disposeTemperatureDifferenceTextures(material: THREE.ShaderMaterial) {
  disposeUniqueTextures([
    getTextureUniform(material, "uTexCurrentA").value,
    getTextureUniform(material, "uTexCurrentB").value,
    getTextureUniform(material, "uTexPrevA").value,
    getTextureUniform(material, "uTexPrevB").value,
  ]);
}

function clearTemperatureDifferenceTextures(material: THREE.ShaderMaterial) {
  getTextureUniform(material, "uTexCurrentA").value = null;
  getTextureUniform(material, "uTexCurrentB").value = null;
  getTextureUniform(material, "uTexPrevA").value = null;
  getTextureUniform(material, "uTexPrevB").value = null;
  material.uniforms.uMix.value = 0.0;
  material.needsUpdate = true;
}

function setTemperatureDifferenceTexturePair(
  material: THREE.ShaderMaterial,
  currentTex: THREE.Texture,
  previousTex: THREE.Texture
) {
  getTextureUniform(material, "uTexCurrentA").value = currentTex;
  getTextureUniform(material, "uTexCurrentB").value = currentTex;
  getTextureUniform(material, "uTexPrevA").value = previousTex;
  getTextureUniform(material, "uTexPrevB").value = previousTex;
  material.uniforms.uMix.value = 0.0;
  material.needsUpdate = true;
}

function disposeIfUnkept(
  tex: THREE.Texture | null,
  keep: Set<THREE.Texture>,
  disposed: Set<THREE.Texture>
) {
  if (!tex || keep.has(tex) || disposed.has(tex)) return;
  disposed.add(tex);
  tex.dispose();
}

function crossfadeTemperatureDifferenceTextures(args: {
  material: THREE.ShaderMaterial;
  nextCurrentTex: THREE.Texture;
  nextPreviousTex: THREE.Texture;
  isCancelled: () => boolean;
  fadeMs?: number;
}): number | null {
  const {
    material,
    nextCurrentTex,
    nextPreviousTex,
    isCancelled,
    fadeMs = DEFAULT_TEXTURE_FADE_MS,
  } = args;

  const currentA = getTextureUniform(material, "uTexCurrentA");
  const currentB = getTextureUniform(material, "uTexCurrentB");
  const prevA = getTextureUniform(material, "uTexPrevA");
  const prevB = getTextureUniform(material, "uTexPrevB");

  if (!currentA.value || !prevA.value) {
    setTemperatureDifferenceTexturePair(material, nextCurrentTex, nextPreviousTex);
    return null;
  }

  const keepBefore = new Set<THREE.Texture>([
    currentA.value,
    prevA.value,
    nextCurrentTex,
    nextPreviousTex,
  ]);
  const disposedBefore = new Set<THREE.Texture>();
  disposeIfUnkept(currentB.value, keepBefore, disposedBefore);
  disposeIfUnkept(prevB.value, keepBefore, disposedBefore);

  currentB.value = nextCurrentTex;
  prevB.value = nextPreviousTex;
  material.uniforms.uMix.value = 0.0;
  material.needsUpdate = true;

  animateUniform(material, "uMix", 0.0, 1.0, fadeMs, isCancelled);

  return window.setTimeout(() => {
    if (isCancelled()) return;

    const oldCurrentA = currentA.value;
    const oldPrevA = prevA.value;
    const newCurrent = currentB.value;
    const newPrev = prevB.value;

    currentA.value = newCurrent;
    prevA.value = newPrev;
    currentB.value = newCurrent;
    prevB.value = newPrev;
    material.uniforms.uMix.value = 0.0;
    material.needsUpdate = true;

    const keepAfter = new Set<THREE.Texture>();
    if (newCurrent) keepAfter.add(newCurrent);
    if (newPrev) keepAfter.add(newPrev);

    const disposedAfter = new Set<THREE.Texture>();
    disposeIfUnkept(oldCurrentA, keepAfter, disposedAfter);
    disposeIfUnkept(oldPrevA, keepAfter, disposedAfter);
  }, fadeMs + 20);
}

export default function TemperatureDifferenceLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("temperature-difference");

  const pressureLevel = useControls((st) => st.temperatureDifference.pressureLevel);

  const meshRef = useRef<THREE.Mesh | null>(null);
  const reqIdRef = useRef(0);
  const pendingRef = useRef<TemperatureDifferenceParams | null>(null);
  const hasContentRef = useRef(false);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;
    const s = useControls.getState();
    pendingRef.current = s.temperatureDifference;

    const R = 100;
    const LIFT = R * 0.0029;
    const geom = new THREE.SphereGeometry(R + LIFT, 128, 128);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uTexCurrentA: { value: null as THREE.Texture | null },
        uTexCurrentB: { value: null as THREE.Texture | null },
        uTexPrevA: { value: null as THREE.Texture | null },
        uTexPrevB: { value: null as THREE.Texture | null },
        uMix: { value: 0.0 },
        uLonOffset: { value: 0.25 },
        uDataMin: { value: 0 },
        uDataMax: { value: 1 },
        uDisplayMin: { value: s.temperatureDifference.uDeltaMin },
        uDisplayMax: { value: s.temperatureDifference.uDeltaMax },
        uGamma: { value: s.temperatureDifference.uGamma },
        uAlpha: { value: s.temperatureDifference.uAlpha },
        uContrast: { value: s.temperatureDifference.uContrast },
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
uniform sampler2D uTexCurrentA;
uniform sampler2D uTexCurrentB;
uniform sampler2D uTexPrevA;
uniform sampler2D uTexPrevB;
uniform float uMix;
uniform float uLonOffset;
uniform float uDataMin;
uniform float uDataMax;
uniform float uDisplayMin;
uniform float uDisplayMax;
uniform float uGamma;
uniform float uAlpha;
uniform float uContrast;
uniform float uLayerOpacity;

varying vec2 vUv;

vec3 palette(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 cool = vec3(0.12, 0.42, 0.95);
  vec3 neutral = vec3(0.95, 0.97, 1.00);
  vec3 warm = vec3(0.92, 0.12, 0.12);
  if (t < 0.5) return mix(cool, neutral, t * 2.0);
  return mix(neutral, warm, (t - 0.5) * 2.0);
}

void main() {
  vec2 uv = vUv;
  uv.x = fract(uv.x + uLonOffset);

  float xCurrentA = texture2D(uTexCurrentA, uv).r;
  float xCurrentB = texture2D(uTexCurrentB, uv).r;
  float xPrevA = texture2D(uTexPrevA, uv).r;
  float xPrevB = texture2D(uTexPrevB, uv).r;

  float currentMix = clamp(uMix, 0.0, 1.0);
  float xCurrent = mix(xCurrentA, xCurrentB, currentMix);
  float xPrev = mix(xPrevA, xPrevB, currentMix);

  float tempCurrentK = mix(uDataMin, uDataMax, xCurrent);
  float tempPrevK = mix(uDataMin, uDataMax, xPrev);
  float deltaK = tempCurrentK - tempPrevK;

  float denom = max(uDisplayMax - uDisplayMin, 1e-6);
  float t = clamp((deltaK - uDisplayMin) / denom, 0.0, 1.0);

  t = pow(t, max(uGamma, 1e-6));

  float c = max(uContrast, 1e-6);
  t = clamp((t - 0.5) * c + 0.5, 0.0, 1.0);

  vec3 col = palette(t);
  float alpha = clamp(uAlpha, 0.0, 1.0) * clamp(uLayerOpacity, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
      `,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "temperature-difference-layer";
    mesh.renderOrder = 61;
    mesh.frustumCulled = false;
    mesh.visible = s.temperatureDifference.pressureLevel !== "none" && hasContentRef.current;

    scene.add(mesh);
    meshRef.current = mesh;

    return () => {
      meshRef.current = null;

      mesh.removeFromParent();
      geom.dispose();

      disposeTemperatureDifferenceTextures(mat);
      mat.dispose();
    };
  }, [engineReady, globeRef, sceneRef]);

  useEffect(() => {
    if (!engineReady) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    pendingRef.current = useControls.getState().temperatureDifference;

    const unsub = useControls.subscribe(
      (st) => st.temperatureDifference,
      (p) => {
        pendingRef.current = p;
        mesh.visible = p.pressureLevel !== "none" && hasContentRef.current;
        if (hasContentRef.current) {
          applyTemperatureDifferenceDisplayParams(
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
      disposeTemperatureDifferenceTextures(mat);
      clearTemperatureDifferenceTextures(mat);
      mat.uniforms.uLayerOpacity.value = 0.0;
      signalReady(timestamp);
      return () => {
        cancelled = true;
      };
    }

    mesh.visible = hasContentRef.current;

    const currentUrl = temperatureApiUrl(timestamp, level);
    const previousTimestamp = oneHourBackTimestamp(timestamp);
    const previousUrl = previousTimestamp
      ? temperatureApiUrl(previousTimestamp, level)
      : currentUrl;

    const loader = new THREE.TextureLoader();
    loadTemperatureTexturePair({ loader, currentUrl, previousUrl })
      .then(({ currentTex, previousTex }) => {
        if (isCancelled()) {
          currentTex.dispose();
          if (previousTex !== currentTex) previousTex.dispose();
          return;
        }

        configureDataTexture(currentTex);
        if (previousTex !== currentTex) configureDataTexture(previousTex);

        const latest = pendingRef.current ?? useControls.getState().temperatureDifference;
        applyTemperatureDifferenceLoadedLevelParams(mat, latest, level);

        const hadVisibleContent = hasContentRef.current;
        hasContentRef.current = true;
        mesh.visible = true;

        if (!hadVisibleContent) {
          disposeTemperatureDifferenceTextures(mat);
          setTemperatureDifferenceTexturePair(mat, currentTex, previousTex);
          mat.uniforms.uLayerOpacity.value = 0.0;

          animateUniform(mat, "uLayerOpacity", 0.0, 1.0, 220, isCancelled);
          signalReady(timestamp);
          return;
        }

        mat.uniforms.uLayerOpacity.value = 1.0;
        crossfadeTemperatureDifferenceTextures({
          material: mat,
          nextCurrentTex: currentTex,
          nextPreviousTex: previousTex,
          isCancelled,
        });
        signalReady(timestamp);
      })
      .catch((err) => {
        if (isCancelled()) return;
        console.error("Failed to load temperature difference pngs", err);
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
