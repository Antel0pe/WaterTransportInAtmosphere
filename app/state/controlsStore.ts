import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

type LayerToggles = {
  moisture: boolean;
  evaporation: boolean;
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

type ControlsState = {
  layers: LayerToggles;
  evap: EvapParams;
  moisture: MoistureParams;

  setLayer: (k: keyof LayerToggles, v: boolean) => void;
  setEvap: (patch: Partial<EvapParams>) => void;
  setMoisture: (patch: Partial<MoistureParams>) => void;
};

export const useControls = create<ControlsState>()(
  subscribeWithSelector((set) => ({
    layers: { moisture: true, evaporation: true },

    evap: {
      uEvapMin: 0,
      uEvapMax: 1,
      uThreshold: 0.2,
      uGamma: 1.0,
      uAlphaScale: 1.0,
    },

    moisture: {
      uAnomMin: -50,
      uAnomMax: 50,
      uThreshold: 10,
      uGamma: 1.0,
    },

    setLayer: (k, v) =>
      set((s) => ({ layers: { ...s.layers, [k]: v } })),

    setEvap: (patch) =>
      set((s) => ({ evap: { ...s.evap, ...patch } })),

    setMoisture: (patch) =>
      set((s) => ({ moisture: { ...s.moisture, ...patch } })),
  }))
);
