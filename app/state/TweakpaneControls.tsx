"use client";

import { useEffect, useRef } from "react";
import { Pane } from "tweakpane";
import {
  CONTOURS_PRESSURE_OPTIONS,
  ContoursPressure,
  LayerToggles,
  useControls,
  WIND_TILE_PRESSURE_OPTIONS,
  WIND_TRAILS_PRESSURE_OPTIONS,
  WindTilePressure,
  WindTrailsPressure,
} from "../state/controlsStore";

export default function TweakpaneControls() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const pane = new Pane({
      title: "Debug Controls",
      expanded: true,
    });

    hostRef.current.appendChild(pane.element);

    const s0 = useControls.getState();

    // Tweakpane binds to this mutable object
    const ui = {
      moisture: s0.layers.moisture,
      evaporation: s0.layers.evaporation,
      ivt: s0.layers.ivt,
      pv: s0.layers.pv,

      uAnomMin: s0.moisture.uAnomMin,
      uAnomMax: s0.moisture.uAnomMax,
      moistureThreshold: s0.moisture.uThreshold,
      moistureGamma: s0.moisture.uGamma,

      uEvapMin: s0.evap.uEvapMin,
      uEvapMax: s0.evap.uEvapMax,
      evapThreshold: s0.evap.uThreshold,
      evapGamma: s0.evap.uGamma,
      uAlphaScale: s0.evap.uAlphaScale,

      uIvtMin: s0.ivt.uIvtMin,
      uIvtMax: s0.ivt.uIvtMax,
      ivtScale: s0.ivt.uScale,
      ivtGamma: s0.ivt.uGamma,

      pvPressureLevel: s0.pv.pressureLevel,
      uPvMin: s0.pv.uPvMin,
      uPvMax: s0.pv.uPvMax,
      pvGamma: s0.pv.uGamma,
      pvAlpha: s0.pv.uAlpha,

      mslContrast: s0.mslContours.contrast,
      mslOpacity: s0.mslContours.opacity,
      contoursPressure: s0.contoursPressure as ContoursPressure,

      windTrailsPressure: s0.windTrailsPressure as WindTrailsPressure,
      windTilePressure: s0.windTilePressure as WindTilePressure,
    };
    const contoursPressureOptions = Object.fromEntries(
      CONTOURS_PRESSURE_OPTIONS.map((opt) => [opt.label, opt.value])
    );
    const windTrailsPressureOptions = Object.fromEntries(
      WIND_TRAILS_PRESSURE_OPTIONS.map((opt) => [opt.label, opt.value])
    );
    const windTilePressureOptions = Object.fromEntries(
      WIND_TILE_PRESSURE_OPTIONS.map((opt) => [opt.label, opt.value])
    );

    // ---- Reset ----
    const defaults = {
      layers: { ...s0.layers },
      moisture: { ...s0.moisture },
      evap: { ...s0.evap },
      ivt: { ...s0.ivt },
      pv: { ...s0.pv },
      mslContours: { ...s0.mslContours },
      contoursPressure: s0.contoursPressure as ContoursPressure,
      windTrailsPressure: s0.windTrailsPressure as WindTrailsPressure,
      windTilePressure: s0.windTilePressure as WindTilePressure,
    };

    pane.addButton({ title: "Reset to defaults" }).on("click", () => {
      const st = useControls.getState();

      // update store
      (Object.keys(defaults.layers) as (keyof LayerToggles)[]).forEach((k) => {
        st.setLayer(k, defaults.layers[k]);
      });
      st.setMoisture(defaults.moisture);
      st.setEvap(defaults.evap);
      st.setIVT(defaults.ivt);
      st.setMslContours(defaults.mslContours);

      // update tweakpane-bound object immediately
      ui.moisture = defaults.layers.moisture;
      ui.evaporation = defaults.layers.evaporation;
      ui.ivt = defaults.layers.ivt;
      ui.pv = defaults.layers.pv;

      ui.uAnomMin = defaults.moisture.uAnomMin;
      ui.uAnomMax = defaults.moisture.uAnomMax;
      ui.moistureThreshold = defaults.moisture.uThreshold;
      ui.moistureGamma = defaults.moisture.uGamma;

      ui.uEvapMin = defaults.evap.uEvapMin;
      ui.uEvapMax = defaults.evap.uEvapMax;
      ui.evapThreshold = defaults.evap.uThreshold;
      ui.evapGamma = defaults.evap.uGamma;
      ui.uAlphaScale = defaults.evap.uAlphaScale;

      ui.uIvtMin = defaults.ivt.uIvtMin;
      ui.uIvtMax = defaults.ivt.uIvtMax;
      ui.ivtScale = defaults.ivt.uScale;
      ui.ivtGamma = defaults.ivt.uGamma;

      ui.pvPressureLevel = defaults.pv.pressureLevel;
      ui.uPvMin = defaults.pv.uPvMin;
      ui.uPvMax = defaults.pv.uPvMax;
      ui.pvGamma = defaults.pv.uGamma;
      ui.pvAlpha = defaults.pv.uAlpha;

      ui.mslContrast = defaults.mslContours.contrast;
      ui.mslOpacity = defaults.mslContours.opacity;
      ui.contoursPressure = defaults.contoursPressure;
      st.setContoursPressure(defaults.contoursPressure);

      ui.windTrailsPressure = defaults.windTrailsPressure;
      st.setWindTrailsPressure(defaults.windTrailsPressure);
      ui.windTilePressure = defaults.windTilePressure;
      st.setWindTilePressure(defaults.windTilePressure);
      st.setPV(defaults.pv);

      pane.refresh();
    });

    // ---- Layers ----
    const layersFolder = pane.addFolder({ title: "Layers" });

    const bMoisture = layersFolder.addBinding(ui, "moisture", {
      label: "Moisture",
    });
    const bEvap = layersFolder.addBinding(ui, "evaporation", {
      label: "Evaporation",
    });

    bMoisture.on("change", (e) => {
      useControls.getState().setLayer("moisture", !!e.value);
    });
    bEvap.on("change", (e) => {
      useControls.getState().setLayer("evaporation", !!e.value);
    });

    // ---- Moisture params (sliders) ----
    const moistureFolder = pane.addFolder({ title: "Moisture Params" });

    const bAnomMin = moistureFolder.addBinding(ui, "uAnomMin", {
      label: "uAnomMin",
      min: -200,
      max: 200,
      step: 1,
    });

    const bAnomMax = moistureFolder.addBinding(ui, "uAnomMax", {
      label: "uAnomMax",
      min: -200,
      max: 200,
      step: 1,
    });

    const bMoistThr = moistureFolder.addBinding(ui, "moistureThreshold", {
      label: "threshold",
      min: -200,
      max: 200,
      step: 0.5,
    });

    const bMoistGamma = moistureFolder.addBinding(ui, "moistureGamma", {
      label: "gamma",
      min: 0.1,
      max: 3.0,
      step: 0.05,
    });

    bAnomMin.on("change", (e) => {
      useControls.getState().setMoisture({ uAnomMin: Number(e.value) });
    });
    bAnomMax.on("change", (e) => {
      useControls.getState().setMoisture({ uAnomMax: Number(e.value) });
    });
    bMoistThr.on("change", (e) => {
      useControls.getState().setMoisture({ uThreshold: Number(e.value) });
    });
    bMoistGamma.on("change", (e) => {
      useControls.getState().setMoisture({ uGamma: Number(e.value) });
    });

    // ---- Evap params (sliders) ----
    const evapFolder = pane.addFolder({ title: "Evap Params" });

    // NOTE: your evap values are typically tiny (e.g., 0..0.003),
    // so use tight slider ranges for usability.
    const bEvapMin = evapFolder.addBinding(ui, "uEvapMin", {
      label: "uEvapMin",
      min: -0.01,
      max: 0.01,
      step: 0.00001,
    });

    const bEvapMax = evapFolder.addBinding(ui, "uEvapMax", {
      label: "uEvapMax",
      min: 0.0,
      max: 0.01,
      step: 0.00001,
    });

    const bEvapThr = evapFolder.addBinding(ui, "evapThreshold", {
      label: "threshold",
      min: 0.0,
      max: 0.01,
      step: 0.00001,
    });

    const bEvapGamma = evapFolder.addBinding(ui, "evapGamma", {
      label: "gamma",
      min: 0.1,
      max: 3.0,
      step: 0.05,
    });

    const bAlphaScale = evapFolder.addBinding(ui, "uAlphaScale", {
      label: "alphaScale",
      min: 0.0,
      max: 2.0,
      step: 0.05,
    });

    bEvapMin.on("change", (e) => {
      useControls.getState().setEvap({ uEvapMin: Number(e.value) });
    });
    bEvapMax.on("change", (e) => {
      useControls.getState().setEvap({ uEvapMax: Number(e.value) });
    });
    bEvapThr.on("change", (e) => {
      useControls.getState().setEvap({ uThreshold: Number(e.value) });
    });
    bEvapGamma.on("change", (e) => {
      useControls.getState().setEvap({ uGamma: Number(e.value) });
    });
    bAlphaScale.on("change", (e) => {
      useControls.getState().setEvap({ uAlphaScale: Number(e.value) });
    });

    const bIVT = layersFolder.addBinding(ui, "ivt", { label: "IVT" });
    bIVT.on("change", (e) => {
      useControls.getState().setLayer("ivt", !!e.value);
    });

    const bPV = layersFolder.addBinding(ui, "pv", { label: "Potential Vorticity" });
    bPV.on("change", (e) => {
      useControls.getState().setLayer("pv", !!e.value);
    });

    const ivtFolder = pane.addFolder({ title: "IVT Params" });

    const bIvtMin = ivtFolder.addBinding(ui, "uIvtMin", {
      label: "uIvtMin",
      min: 0.0,
      max: 1.0,
      step: 0.01,
    });

    const bIvtMax = ivtFolder.addBinding(ui, "uIvtMax", {
      label: "uIvtMax",
      min: 0.0,
      max: 2.0,
      step: 0.01,
    });

    const bIvtScale = ivtFolder.addBinding(ui, "ivtScale", {
      label: "scale",
      min: 0.1,
      max: 5.0,
      step: 0.05,
    });

    const bIvtGamma = ivtFolder.addBinding(ui, "ivtGamma", {
      label: "gamma",
      min: 0.1,
      max: 3.0,
      step: 0.05,
    });
    bIvtMin.on("change", (e) => {
      useControls.getState().setIVT({ uIvtMin: Number(e.value) });
    });
    bIvtMax.on("change", (e) => {
      useControls.getState().setIVT({ uIvtMax: Number(e.value) });
    });
    bIvtScale.on("change", (e) => {
      useControls.getState().setIVT({ uScale: Number(e.value) });
    });
    bIvtGamma.on("change", (e) => {
      useControls.getState().setIVT({ uGamma: Number(e.value) });
    });

    const pvFolder = pane.addFolder({ title: "Potential Vorticity Params" });
    const bPvLevel = pvFolder.addBinding(ui, "pvPressureLevel", {
      label: "pressure",
      options: {
        "250 hPa": 250,
        "500 hPa": 500,
        "925 hPa": 925,
      },
    });
    const bPvMin = pvFolder.addBinding(ui, "uPvMin", {
      label: "uPvMin",
      min: -5e-6,
      max: 5e-5,
      step: 1e-7,
    });
    const bPvMax = pvFolder.addBinding(ui, "uPvMax", {
      label: "uPvMax",
      min: 1e-7,
      max: 8e-5,
      step: 1e-7,
    });
    const bPvGamma = pvFolder.addBinding(ui, "pvGamma", {
      label: "gamma",
      min: 0.1,
      max: 3.0,
      step: 0.05,
    });
    const bPvAlpha = pvFolder.addBinding(ui, "pvAlpha", {
      label: "alpha",
      min: 0.0,
      max: 1.0,
      step: 0.01,
    });

    bPvLevel.on("change", (e) => {
      useControls.getState().setPV({ pressureLevel: Number(e.value) });
    });
    bPvMin.on("change", (e) => {
      useControls.getState().setPV({ uPvMin: Number(e.value) });
    });
    bPvMax.on("change", (e) => {
      useControls.getState().setPV({ uPvMax: Number(e.value) });
    });
    bPvGamma.on("change", (e) => {
      useControls.getState().setPV({ uGamma: Number(e.value) });
    });
    bPvAlpha.on("change", (e) => {
      useControls.getState().setPV({ uAlpha: Number(e.value) });
    });


    // ---- subscriptions: keep tweakpane in sync if store changes elsewhere ----
    const unsubMoistureVis = useControls.subscribe(
      (s) => s.layers.moisture,
      (v) => {
        ui.moisture = v;
        pane.refresh();
      }
    );

    const unsubEvapVis = useControls.subscribe(
      (s) => s.layers.evaporation,
      (v) => {
        ui.evaporation = v;
        pane.refresh();
      }
    );

    const unsubMoistureParams = useControls.subscribe(
      (s) => s.moisture,
      (p) => {
        ui.uAnomMin = p.uAnomMin;
        ui.uAnomMax = p.uAnomMax;
        ui.moistureThreshold = p.uThreshold;
        ui.moistureGamma = p.uGamma;
        pane.refresh();
      }
    );

    const unsubEvapParams = useControls.subscribe(
      (s) => s.evap,
      (p) => {
        ui.uEvapMin = p.uEvapMin;
        ui.uEvapMax = p.uEvapMax;
        ui.evapThreshold = p.uThreshold;
        ui.evapGamma = p.uGamma;
        ui.uAlphaScale = p.uAlphaScale;
        pane.refresh();
      }
    );

    const unsubIVTVis = useControls.subscribe(
      (s) => s.layers.ivt,
      (v) => {
        ui.ivt = v;
        pane.refresh();
      }
    );

    const unsubPVVis = useControls.subscribe(
      (s) => s.layers.pv,
      (v) => {
        ui.pv = v;
        pane.refresh();
      }
    );

    const unsubIVTParams = useControls.subscribe(
      (s) => s.ivt,
      (p) => {
        ui.uIvtMin = p.uIvtMin;
        ui.uIvtMax = p.uIvtMax;
        ui.ivtScale = p.uScale;
        ui.ivtGamma = p.uGamma;
        pane.refresh();
      }
    );

    const unsubPVParams = useControls.subscribe(
      (s) => s.pv,
      (p) => {
        ui.pvPressureLevel = p.pressureLevel;
        ui.uPvMin = p.uPvMin;
        ui.uPvMax = p.uPvMax;
        ui.pvGamma = p.uGamma;
        ui.pvAlpha = p.uAlpha;
        pane.refresh();
      }
    );

    const bContoursPressure = layersFolder.addBinding(ui, "contoursPressure", {
      label: "Contours",
      options: contoursPressureOptions,
    });
    bContoursPressure.on("change", (e) => {
      useControls.getState().setContoursPressure(e.value as ContoursPressure);
    });

    const mslFolder = pane.addFolder({ title: "Contours Params" });

    const bMslContrast = mslFolder.addBinding(ui, "mslContrast", {
      label: "contrast",
      min: 1.0,
      max: 8.0,
      step: 0.1,
    });
    const bMslOpacity = mslFolder.addBinding(ui, "mslOpacity", {
      label: "opacity",
      min: 0.0,
      max: 1.0,
      step: 0.01,
    });

    bMslContrast.on("change", (e) => useControls.getState().setMslContours({ contrast: Number(e.value) }));
    bMslOpacity.on("change", (e) => useControls.getState().setMslContours({ opacity: Number(e.value) }));
    const bWindTrailsPressure = layersFolder.addBinding(ui, "windTrailsPressure", {
      label: "Wind Trails",
      options: windTrailsPressureOptions,
    });
    bWindTrailsPressure.on("change", (e) => {
      useControls.getState().setWindTrailsPressure(e.value as WindTrailsPressure);
    });

    const bWindTilePressure = layersFolder.addBinding(ui, "windTilePressure", {
      label: "Wind Tile",
      options: windTilePressureOptions,
    });
    bWindTilePressure.on("change", (e) => {
      useControls.getState().setWindTilePressure(e.value as WindTilePressure);
    });

    const unsubMslParams = useControls.subscribe(
      (s) => s.mslContours,
      (p) => {
        ui.mslContrast = p.contrast;
        ui.mslOpacity = p.opacity;
        pane.refresh();
      }
    );
    const unsubContoursPressure = useControls.subscribe(
      (s) => s.contoursPressure,
      (v) => {
        ui.contoursPressure = v as ContoursPressure;
        pane.refresh();
      }
    );

    const unsubWindPressure = useControls.subscribe(
      (s) => s.windTrailsPressure,
      (v) => {
        ui.windTrailsPressure = v as WindTrailsPressure;
        pane.refresh();
      }
    );
    const unsubWindTilePressure = useControls.subscribe(
      (s) => s.windTilePressure,
      (v) => {
        ui.windTilePressure = v as WindTilePressure;
        pane.refresh();
      }
    );

    pane.element.style.width = "100%";

    return () => {
      unsubMoistureVis();
      unsubEvapVis();
      unsubMoistureParams();
      unsubEvapParams();
      unsubIVTVis();
      unsubIVTParams();
      unsubPVVis();
      unsubPVParams();
      unsubMslParams();
      unsubContoursPressure();
      unsubWindPressure();
      unsubWindTilePressure();

      pane.dispose();
      pane.element.remove();
    };
  }, []);

  return <div ref={hostRef} style={{ padding: 12 }} />;
}
