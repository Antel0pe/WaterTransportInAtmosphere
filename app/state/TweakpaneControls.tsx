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

    // Attach pane to this component's DOM
    hostRef.current.appendChild(pane.element);

    const ui = {
      moisture: useControls.getState().layers.moisture,
      evaporation: useControls.getState().layers.evaporation,
    };

    const folder = pane.addFolder({ title: "Layers" });

    const bMoisture = folder.addBinding(ui, "moisture", { label: "Moisture" });
    const bEvap = folder.addBinding(ui, "evaporation", { label: "Evaporation" });

    bMoisture.on("change", (e) => {
      useControls.getState().setLayer("moisture", !!e.value);
    });
    bEvap.on("change", (e) => {
      useControls.getState().setLayer("evaporation", !!e.value);
    });

    const unsubMoisture = useControls.subscribe(
      (s) => s.layers.moisture,
      (v) => {
        ui.moisture = v;
        pane.refresh();
      }
    );

    const unsubEvap = useControls.subscribe(
      (s) => s.layers.evaporation,
      (v) => {
        ui.evaporation = v;
        pane.refresh();
      }
    );

    // IMPORTANT: remove the fixed positioning styles
    // (Let it flow inside the sidebar)
    pane.element.style.width = "100%";

    return () => {
      unsubMoisture();
      unsubEvap();
      pane.dispose();
      // Pane dispose removes listeners; but also detach in case
      pane.element.remove();
    };
  }, []);

  return <div ref={hostRef} style={{ padding: 12 }} />;
}
