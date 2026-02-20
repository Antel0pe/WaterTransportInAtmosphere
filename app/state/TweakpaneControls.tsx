"use client";

import { useEffect, useRef } from "react";
import { Pane } from "tweakpane";
import { useControls } from "../state/controlsStore";

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
    };


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


    pane.element.style.width = "100%";

    return () => {
      unsubMoistureVis();
      unsubEvapVis();
      unsubMoistureParams();
      unsubEvapParams();
      unsubIVTVis();
      unsubIVTParams();

      pane.dispose();
      pane.element.remove();
    };
  }, []);

  return <div ref={hostRef} style={{ padding: 12 }} />;
}
