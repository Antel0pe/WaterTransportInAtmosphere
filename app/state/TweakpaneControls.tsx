"use client";

import { useEffect, useRef } from "react";
import { Pane } from "tweakpane";
import {
  CONTOURS_PRESSURE_OPTIONS,
  ContoursPressure,
  PVPressure,
  PV_PRESSURE_OPTIONS,
  useControls,
  WIND_TRAILS_PRESSURE_OPTIONS,
  WindTrailsPressure,
} from "../state/controlsStore";
import { addButtonRowToFolder, addSeparatorToFolder } from "./TweakpaneUtils";

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
    };

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
    };
    let pvButtonsApi: ReturnType<typeof addButtonRowToFolder> | null = null;
    let contoursButtonsApi: ReturnType<typeof addButtonRowToFolder> | null = null;
    let windButtonsApi: ReturnType<typeof addButtonRowToFolder> | null = null;

    pane.addButton({ title: "Reset to defaults" }).on("click", () => {
      const st = useControls.getState();

      // update store
      (Object.keys(defaults.layers) as Array<keyof typeof defaults.layers>).forEach((k) => {
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
      st.setPV(defaults.pv);
      pvButtonsApi?.setSelectedValue(defaults.pv.pressureLevel);
      contoursButtonsApi?.setSelectedValue(defaults.contoursPressure);
      windButtonsApi?.setSelectedValue(defaults.windTrailsPressure);

      
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
        
      }
    );

    const unsubEvapVis = useControls.subscribe(
      (s) => s.layers.evaporation,
      (v) => {
        ui.evaporation = v;
        
      }
    );

    const unsubMoistureParams = useControls.subscribe(
      (s) => s.moisture,
      (p) => {
        ui.uAnomMin = p.uAnomMin;
        ui.uAnomMax = p.uAnomMax;
        ui.moistureThreshold = p.uThreshold;
        ui.moistureGamma = p.uGamma;
        
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
        
      }
    );

    const unsubIVTVis = useControls.subscribe(
      (s) => s.layers.ivt,
      (v) => {
        ui.ivt = v;
        
      }
    );

    const unsubIVTParams = useControls.subscribe(
      (s) => s.ivt,
      (p) => {
        ui.uIvtMin = p.uIvtMin;
        ui.uIvtMax = p.uIvtMax;
        ui.ivtScale = p.uScale;
        ui.ivtGamma = p.uGamma;
        
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
        pvButtonsApi?.setSelectedValue(p.pressureLevel);
        
      }
    );

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

    addSeparatorToFolder(layersFolder);
    pvButtonsApi = addButtonRowToFolder(layersFolder, {
      label: "PV",
      selectedValue: ui.pvPressureLevel,
      buttons: PV_PRESSURE_OPTIONS.map((opt) => ({
        title: opt.label,
        value: opt.value,
        onClick: () => {
          const v = opt.value as PVPressure;
          useControls.getState().setPV({ pressureLevel: v });
          ui.pvPressureLevel = v;
          
        },
      })),
    });

    addSeparatorToFolder(layersFolder);
    contoursButtonsApi = addButtonRowToFolder(layersFolder, {
      label: "Contours",
      selectedValue: ui.contoursPressure,
      buttons: CONTOURS_PRESSURE_OPTIONS.map((opt) => ({
        title: opt.label,
        value: opt.value,
        onClick: () => {
          const v = opt.value as ContoursPressure;
          useControls.getState().setContoursPressure(v);
          ui.contoursPressure = v;
          
        },
      })),
    });

    addSeparatorToFolder(layersFolder);
    windButtonsApi = addButtonRowToFolder(layersFolder, {
      label: "Wind Trails",
      selectedValue: ui.windTrailsPressure,
      buttons: WIND_TRAILS_PRESSURE_OPTIONS.map((opt) => ({
        title: opt.label,
        value: opt.value,
        onClick: () => {
          const v = opt.value as WindTrailsPressure;
          useControls.getState().setWindTrailsPressure(v);
          ui.windTrailsPressure = v;
          
        },
      })),
    });

    const unsubMslParams = useControls.subscribe(
      (s) => s.mslContours,
      (p) => {
        ui.mslContrast = p.contrast;
        ui.mslOpacity = p.opacity;
        
      }
    );
    const unsubContoursPressure = useControls.subscribe(
      (s) => s.contoursPressure,
      (v) => {
        ui.contoursPressure = v as ContoursPressure;
        contoursButtonsApi?.setSelectedValue(v as ContoursPressure);
        
      }
    );

    const unsubWindPressure = useControls.subscribe(
      (s) => s.windTrailsPressure,
      (v) => {
        ui.windTrailsPressure = v as WindTrailsPressure;
        windButtonsApi?.setSelectedValue(v as WindTrailsPressure);
        
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
      unsubPVParams();
      unsubMslParams();
      unsubContoursPressure();
      unsubWindPressure();

      pane.dispose();
      pane.element.remove();
    };
  }, []);

  return <div ref={hostRef} style={{ padding: 12 }} />;
}
