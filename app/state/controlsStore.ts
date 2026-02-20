import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

type LayerToggles = {
  moisture: boolean;
  evaporation: boolean;
  ivt: boolean;
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


type ControlsState = {
  layers: LayerToggles;
  evap: EvapParams;
  moisture: MoistureParams;
  ivt: IVTParams;

  setLayer: (k: keyof LayerToggles, v: boolean) => void;
  setEvap: (patch: Partial<EvapParams>) => void;
  setMoisture: (patch: Partial<MoistureParams>) => void;
  setIVT: (patch: Partial<IVTParams>) => void;
};

export const useControls = create<ControlsState>()(
  subscribeWithSelector((set) => ({
    layers: { moisture: true, evaporation: true, ivt: true },

    evap: {
      uEvapMin: -5e-4,
      uEvapMax: 5e-4,
      uThreshold: 5e-5,
      uGamma: 1.5,
      uAlphaScale: 0.75,
    },


    moisture: {
      uAnomMin: -50,
      uAnomMax: 50,
      uThreshold: 10,
      uGamma: 1.0,
    },

    ivt: {
      uIvtMin: 0.0,
      uIvtMax: 0.8,
      uScale: 1.25,
      uGamma: 0.85,
    },

    setLayer: (k, v) =>
      set((s) => ({ layers: { ...s.layers, [k]: v } })),

    setEvap: (patch) =>
      set((s) => ({ evap: { ...s.evap, ...patch } })),

    setMoisture: (patch) =>
      set((s) => ({ moisture: { ...s.moisture, ...patch } })),

    setIVT: (patch) =>
      set((s) => ({ ivt: { ...s.ivt, ...patch } })),

  }))
);
