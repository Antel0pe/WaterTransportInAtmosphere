import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer } from "./EarthBase";
import { temperatureApiUrl } from "../utils/ApiResponses";
import { TemperatureDiffPressure, useControls } from "../../state/controlsStore";
import { configureDataTexture } from "./shaderUtils";

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

function applyTemperatureDifferenceParams(
  mat: THREE.ShaderMaterial,
  p: TemperatureDifferenceParams,
  level: SupportedLevel
) {
  const r = defaultRangeForLevel(level);
  mat.uniforms.uDataMin.value = r.min;
  mat.uniforms.uDataMax.value = r.max;

  mat.uniforms.uDisplayMin.value = p.uDeltaMin;
  mat.uniforms.uDisplayMax.value = p.uDeltaMax;
  mat.uniforms.uGamma.value = p.uGamma;
  mat.uniforms.uAlpha.value = p.uAlpha;
  mat.uniforms.uContrast.value = p.uContrast;
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

export default function TemperatureDifferenceLayer() {
  const { engineReady, sceneRef, globeRef, timestamp, signalReady } =
    useEarthLayer("temperature-difference");

  const pressureLevel = useControls((st) => st.temperatureDifference.pressureLevel);

  const meshARef = useRef<THREE.Mesh | null>(null);
  const meshBRef = useRef<THREE.Mesh | null>(null);

  const activeRef = useRef<"A" | "B">("A");
  const reqIdRef = useRef(0);
  const pendingRef = useRef<TemperatureDifferenceParams | null>(null);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current || !globeRef.current) return;

    const scene = sceneRef.current;
    const s = useControls.getState();
    pendingRef.current = s.temperatureDifference;

    const R = 100;
    const LIFT = R * 0.0029;
    const EPS = R * 0.00002;
    const geomA = new THREE.SphereGeometry(R + LIFT, 128, 128);
    const geomB = new THREE.SphereGeometry(R + LIFT + EPS, 128, 128);

    const makeMaterial = () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        uniforms: {
          uTexCurrent: { value: null as THREE.Texture | null },
          uTexPrev: { value: null as THREE.Texture | null },
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
uniform sampler2D uTexCurrent;
uniform sampler2D uTexPrev;
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

  float xCurrent = texture2D(uTexCurrent, uv).r;
  float xPrev = texture2D(uTexPrev, uv).r;

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

    const matA = makeMaterial();
    const matB = makeMaterial();

    const meshA = new THREE.Mesh(geomA, matA);
    meshA.name = "temperature-difference-layer-A";
    meshA.renderOrder = 61;
    meshA.frustumCulled = false;

    const meshB = new THREE.Mesh(geomB, matB);
    meshB.name = "temperature-difference-layer-B";
    meshB.renderOrder = 62;
    meshB.frustumCulled = false;

    matB.uniforms.uLayerOpacity.value = 0.0;

    const visible = s.temperatureDifference.pressureLevel !== "none";
    meshA.visible = visible;
    meshB.visible = visible;

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

      geomA.dispose();
      geomB.dispose();

      for (const mesh of [meshA, meshB]) {
        const mat = mesh.material as THREE.ShaderMaterial;
        const texCurrent = mat.uniforms.uTexCurrent.value as THREE.Texture | null;
        const texPrev = mat.uniforms.uTexPrev.value as THREE.Texture | null;
        if (texCurrent) texCurrent.dispose();
        if (texPrev && texPrev !== texCurrent) texPrev.dispose();
        mat.dispose();
      }
    };
  }, [engineReady, globeRef, sceneRef]);

  useEffect(() => {
    if (!engineReady) return;
    const meshA = meshARef.current;
    const meshB = meshBRef.current;
    if (!meshA || !meshB) return;

    pendingRef.current = useControls.getState().temperatureDifference;

    const unsub = useControls.subscribe(
      (st) => st.temperatureDifference,
      (p) => {
        pendingRef.current = p;
        const vis = p.pressureLevel !== "none";
        meshA.visible = vis;
        meshB.visible = vis;
      }
    );

    return () => {
      unsub();
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

    const level = resolveLevel(pressureLevel);

    if (level === null) {
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
        applyTemperatureDifferenceParams(nextMat, latest, level);

        const prevNextCurrentTex = nextMat.uniforms.uTexCurrent.value as THREE.Texture | null;
        const prevNextPrevTex = nextMat.uniforms.uTexPrev.value as THREE.Texture | null;
        nextMat.uniforms.uTexCurrent.value = currentTex;
        nextMat.uniforms.uTexPrev.value = previousTex;
        nextMat.needsUpdate = true;
        if (prevNextCurrentTex) prevNextCurrentTex.dispose();
        if (prevNextPrevTex && prevNextPrevTex !== prevNextCurrentTex) {
          prevNextPrevTex.dispose();
        }

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
      })
      .catch((err) => {
        if (isCancelled()) return;
        console.error("Failed to load temperature difference pngs", err);
        signalReady(timestamp);
      });

    return () => {
      cancelled = true;
    };
  }, [engineReady, pressureLevel, timestamp, signalReady]);

  return null;
}
