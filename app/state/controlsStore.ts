import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type LayerToggles = {
  moisture: boolean;
  evaporation: boolean;
  ivt: boolean;
  backwardTrajectory: boolean;
};

type EvapParams = {
  uEvapMin: number;
  uEvapMax: number;
  uThreshold: number;
  uGamma: number;
  uAlphaScale: number;
};

type MoistureParams = {
  uAnomMin: number;
  uAnomMax: number;
  uThreshold: number;
  uGamma: number;
};

type IVTParams = {
  uIvtMin: number;
  uIvtMax: number;
  uScale: number;
  uGamma: number;
};

type PVParams = {
  pressureLevel: PVPressure;
  uPvMin: number;
  uPvMax: number;
  uGamma: number;
  uAlpha: number;
};

type DivergenceParams = {
  pressureLevel: DivergencePressure;
  uDivMin: number;
  uDivMax: number;
  uGamma: number;
  uAlpha: number;

  uZeroEps: number;   // normalized width around 0 that fades out (0..1)
  uAsinhK: number;    // HDR-ish compression (>0). set 0 to disable
};

type VerticalVelocityParams = {
  pressureLevel: VerticalVelocityPressure;
  uWMin: number;
  uWMax: number;
  uGamma: number;
  uAlpha: number;

  uZeroEps: number;
  uAsinhK: number;
};

type TemperatureParams = {
  pressureLevel: TemperaturePressure;
  uTempMin: number;
  uTempMax: number;
  uGamma: number;
  uAlpha: number;
  uContrast: number;
};

type TemperatureDifferenceParams = {
  pressureLevel: TemperatureDiffPressure;
  uDeltaMin: number;
  uDeltaMax: number;
  uGamma: number;
  uAlpha: number;
  uContrast: number;
};

type MslContoursParams = {
  contrast: number;
  opacity: number;
};

export const CONTOURS_PRESSURE_OPTIONS = [
  { value: "none", label: "None" },
  { value: "msl", label: "MSL" },
  { value: "250", label: "250 hPa" },
  { value: "500", label: "500 hPa" },
  { value: "925", label: "925 hPa" },
] as const;

export type ContoursPressure =
  (typeof CONTOURS_PRESSURE_OPTIONS)[number]["value"];

export const WIND_TRAILS_PRESSURE_OPTIONS = [
  { value: "none", label: "None" },
  { value: 250, label: "250 hPa" },
  { value: 500, label: "500 hPa" },
  { value: 925, label: "925 hPa" },
] as const;

export type WindTrailsPressure =
  (typeof WIND_TRAILS_PRESSURE_OPTIONS)[number]["value"];

export const PV_PRESSURE_OPTIONS = [
  { value: "none", label: "None" },
  { value: 250, label: "250 hPa" },
  { value: 500, label: "500 hPa" },
  { value: 925, label: "925 hPa" },
] as const;

export type PVPressure = (typeof PV_PRESSURE_OPTIONS)[number]["value"];

export const DIVERGENCE_PRESSURE_OPTIONS = [
  { value: "none", label: "None" },
  { value: 250, label: "250 hPa" },
  { value: 500, label: "500 hPa" },
  { value: 925, label: "925 hPa" },
] as const;

export type DivergencePressure =
  (typeof DIVERGENCE_PRESSURE_OPTIONS)[number]["value"];

export const VERTICAL_VELOCITY_PRESSURE_OPTIONS = [
  { value: "none", label: "None" },
  { value: 250, label: "250 hPa" },
  { value: 500, label: "500 hPa" },
  { value: 925, label: "925 hPa" },
] as const;

export type VerticalVelocityPressure =
  (typeof VERTICAL_VELOCITY_PRESSURE_OPTIONS)[number]["value"];

export const TEMPERATURE_PRESSURE_OPTIONS = [
  { value: "none", label: "None" },
  { value: 250, label: "250 hPa" },
  { value: 500, label: "500 hPa" },
  { value: 925, label: "925 hPa" },
] as const;

export type TemperaturePressure =
  (typeof TEMPERATURE_PRESSURE_OPTIONS)[number]["value"];

export const TEMPERATURE_DIFF_PRESSURE_OPTIONS = [
  { value: "none", label: "None" },
  { value: 250, label: "250 hPa" },
  { value: 500, label: "500 hPa" },
  { value: 925, label: "925 hPa" },
] as const;

export type TemperatureDiffPressure =
  (typeof TEMPERATURE_DIFF_PRESSURE_OPTIONS)[number]["value"];

type ControlsState = {
  layers: LayerToggles;
  evap: EvapParams;
  moisture: MoistureParams;
  ivt: IVTParams;
  pv: PVParams;
  divergence: DivergenceParams;
  verticalVelocity: VerticalVelocityParams;
  temperature: TemperatureParams;
  temperatureDifference: TemperatureDifferenceParams;
  mslContours: MslContoursParams;
  contoursPressure: ContoursPressure;
  windTrailsPressure: WindTrailsPressure;

  setLayer: (k: keyof LayerToggles, v: boolean) => void;
  setEvap: (patch: Partial<EvapParams>) => void;
  setMoisture: (patch: Partial<MoistureParams>) => void;
  setIVT: (patch: Partial<IVTParams>) => void;
  setPV: (patch: Partial<PVParams>) => void;
  setDivergence: (patch: Partial<DivergenceParams>) => void;
  setVerticalVelocity: (patch: Partial<VerticalVelocityParams>) => void;
  setTemperature: (patch: Partial<TemperatureParams>) => void;
  setTemperatureDifference: (patch: Partial<TemperatureDifferenceParams>) => void;
  setMslContours: (patch: Partial<MslContoursParams>) => void;
  setContoursPressure: (pressure: ContoursPressure) => void;
  setWindTrailsPressure: (pressure: WindTrailsPressure) => void;
};

export const useControls = create<ControlsState>()(
  subscribeWithSelector((set) => ({
    layers: {
      moisture: false,
      evaporation: false,
      ivt: false,
      backwardTrajectory: true,
    },

    mslContours: {
      contrast: 3.5,
      opacity: 0.95,
    },
    contoursPressure: "none",
    windTrailsPressure: "none",

    evap: {
      uEvapMin: -5e-4,
      uEvapMax: 5e-4,
      uThreshold: 5e-5,
      uGamma: 1.5,
      uAlphaScale: 0.75,
    },
    moisture: {
      uAnomMin: 0,
      uAnomMax: 100,
      uThreshold: 20,
      uGamma: 1.0,
    },

    ivt: {
      uIvtMin: 0.0,
      uIvtMax: 0.8,
      uScale: 1.25,
      uGamma: 0.85,
    },

    pv: {
      pressureLevel: "none",
      uPvMin: -2e-6,
      uPvMax: 2.4e-5,
      uGamma: 0.9,
      uAlpha: 0.9,
    },

    divergence: {
      pressureLevel: "none",
      uDivMin: -7.0e-4,
      uDivMax: +7.0e-4,
      uGamma: 0.5,
      uAlpha: 0.95,
      uZeroEps: 0.08,
      uAsinhK: 3,
    },

    verticalVelocity: {
      pressureLevel: "none",
      uWMin: -8.0,
      uWMax: +8.0,
      uGamma: 0.5,
      uAlpha: 0.95,
      uZeroEps: 0.06,
      uAsinhK: 3,
    },

    temperature: {
      pressureLevel: "none",
      uTempMin: 180,
      uTempMax: 330,
      uGamma: 1.0,
      uAlpha: 0.95,
      uContrast: 1.6,
    },
    temperatureDifference: {
      pressureLevel: "none",
      uDeltaMin: -4.0,
      uDeltaMax: 4.0,
      uGamma: 1.0,
      uAlpha: 0.95,
      uContrast: 1.5,
    },

    setLayer: (k, v) =>
      set((s) => ({ layers: { ...s.layers, [k]: v } })),

    setEvap: (patch) =>
      set((s) => ({ evap: { ...s.evap, ...patch } })),

    setMoisture: (patch) =>
      set((s) => ({ moisture: { ...s.moisture, ...patch } })),

    setIVT: (patch) =>
      set((s) => ({ ivt: { ...s.ivt, ...patch } })),

    setPV: (patch) =>
      set((s) => ({ pv: { ...s.pv, ...patch } })),

    setDivergence: (patch) =>
      set((s) => ({ divergence: { ...s.divergence, ...patch } })),

    setVerticalVelocity: (patch) =>
      set((s) => ({
        verticalVelocity: { ...s.verticalVelocity, ...patch },
      })),

    setTemperature: (patch) =>
      set((s) => ({
        temperature: { ...s.temperature, ...patch },
      })),

    setTemperatureDifference: (patch) =>
      set((s) => ({
        temperatureDifference: { ...s.temperatureDifference, ...patch },
      })),

    setMslContours: (patch) =>
      set((s) => ({ mslContours: { ...s.mslContours, ...patch } })),

    setContoursPressure: (pressure) =>
      set(() => ({ contoursPressure: pressure })),

    setWindTrailsPressure: (pressure) =>
      set(() => ({ windTrailsPressure: pressure })),
  })),
);
