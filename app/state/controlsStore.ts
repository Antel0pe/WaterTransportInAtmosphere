import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type LayerToggles = {
  moisture: boolean;
  evaporation: boolean;
  ivt: boolean;
  pv: boolean;
  mslContours: boolean;
  windTrails: boolean;
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

type WindTrailsParams = {
  dummy: number; // example param that doesn't do anything yet
};


type ControlsState = {
  layers: LayerToggles;
  evap: EvapParams;
  moisture: MoistureParams;
  ivt: IVTParams;
  pv: PVParams;
  mslContours: MslContoursParams;

  setLayer: (k: keyof LayerToggles, v: boolean) => void;
  setEvap: (patch: Partial<EvapParams>) => void;
  setMoisture: (patch: Partial<MoistureParams>) => void;
  setIVT: (patch: Partial<IVTParams>) => void;
  setPV: (patch: Partial<PVParams>) => void;
  setMslContours: (patch: Partial<MslContoursParams>) => void;

  windTrails: WindTrailsParams;
  setWindTrails: (patch: Partial<WindTrailsParams>) => void;
};

export const useControls = create<ControlsState>()(
  subscribeWithSelector((set) => ({
    layers: {
      moisture: true,
      evaporation: false,
      ivt: false,
      pv: false,
      mslContours: true,
      windTrails: true,
    },

    mslContours: {
      contrast: 3.5,
      opacity: 0.95,
    },

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

    windTrails: {
      dummy: 1.0,
    },

    setWindTrails: (patch) =>
      set((s) => ({ windTrails: { ...s.windTrails, ...patch } })),
  })),



);
