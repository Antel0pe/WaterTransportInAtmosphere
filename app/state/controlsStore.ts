import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type LayerToggles = {
  moisture: boolean;
  evaporation: boolean;
  ivt: boolean;
  pv: boolean;
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
  uIvtMin: number;   // NEW (0.0)
  uIvtMax: number;   // NEW (0.8)
  uScale: number;    // NEW
  uGamma: number;    // NEW
};

type PVParams = {
  pressureLevel: number;
  uPvMin: number;
  uPvMax: number;
  uGamma: number;
  uAlpha: number;
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

export type WindTrailsPressure = (typeof WIND_TRAILS_PRESSURE_OPTIONS)[number]["value"];

export const WIND_TILE_PRESSURE_OPTIONS = [
  { value: "none", label: "None" },
  { value: 250, label: "250 hPa" },
  { value: 500, label: "500 hPa" },
  { value: 925, label: "925 hPa" },
] as const;

export type WindTilePressure = (typeof WIND_TILE_PRESSURE_OPTIONS)[number]["value"];

type ControlsState = {
  layers: LayerToggles;
  evap: EvapParams;
  moisture: MoistureParams;
  ivt: IVTParams;
  pv: PVParams;
  mslContours: MslContoursParams;
  contoursPressure: ContoursPressure;
  windTrailsPressure: WindTrailsPressure;
  windTilePressure: WindTilePressure;

  setLayer: (k: keyof LayerToggles, v: boolean) => void;
  setEvap: (patch: Partial<EvapParams>) => void;
  setMoisture: (patch: Partial<MoistureParams>) => void;
  setIVT: (patch: Partial<IVTParams>) => void;
  setPV: (patch: Partial<PVParams>) => void;
  setMslContours: (patch: Partial<MslContoursParams>) => void;
  setContoursPressure: (pressure: ContoursPressure) => void;
  setWindTrailsPressure: (pressure: WindTrailsPressure) => void;
  setWindTilePressure: (pressure: WindTilePressure) => void;
};

export const useControls = create<ControlsState>()(
  subscribeWithSelector((set) => ({
    layers: {
      moisture: true,
      evaporation: false,
      ivt: false,
      pv: false,
    },

    mslContours: {
      contrast: 3.5,
      opacity: 0.95,
    },
    contoursPressure: "msl",

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
      pressureLevel: 250,
      uPvMin: -2e-6,
      uPvMax: 2.4e-5,
      uGamma: 0.9,
      uAlpha: 0.9,
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

    setMslContours: (patch) =>
      set((s) => ({ mslContours: { ...s.mslContours, ...patch } })),
    setContoursPressure: (pressure) => set(() => ({ contoursPressure: pressure })),
    windTrailsPressure: 925,
    setWindTrailsPressure: (pressure) => set(() => ({ windTrailsPressure: pressure })),
    windTilePressure: "none",
    setWindTilePressure: (pressure) => set(() => ({ windTilePressure: pressure })),
  })),



);
