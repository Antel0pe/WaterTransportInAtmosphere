"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Analytics } from "@vercel/analytics/next";
import SidebarPane from "./sidebar/SidebarPane";
import LayerInfoPane from "./sidebar/LayerInfoPane";

const EarthBase = dynamic(() => import("./layers/EarthBase"), {
  ssr: false,
  loading: () => <div style={{ width: "100%", height: "100%" }} />,
});

const MoistureTransportLayer = dynamic(() => import("./layers/MoistureTransportLayer"), {
  ssr: false,
  loading: () => <div style={{ width: "100%", height: "100%" }} />,
});

const EvaporationLayer = dynamic(() => import("./layers/EvaporationLayer"), {
  ssr: false,
  loading: () => <div style={{ width: "100%", height: "100%" }} />,
});

const IVTLayer = dynamic(() => import("./layers/IVT_Layer"), {
  ssr: false,
  loading: () => <div style={{ width: "100%", height: "100%" }} />,
});

const PotentialVorticityLayer = dynamic(() => import("./layers/PotentialVorticityLayer"), {
  ssr: false,
  loading: () => <div style={{ width: "100%", height: "100%" }} />,
});

const DivergenceLayer = dynamic(() => import("./layers/DivergenceLayer"), {
  ssr: false,
  loading: () => <div style={{ width: "100%", height: "100%" }} />,
});

const VerticalVelocityLayer = dynamic(() => import("./layers/VerticalVelocityLayer"), {
  ssr: false,
  loading: () => <div style={{ width: "100%", height: "100%" }} />,
});

const TemperatureLayer = dynamic(() => import("./layers/TemperatureLayer"), {
  ssr: false,
  loading: () => <div style={{ width: "100%", height: "100%" }} />,
});

const TemperatureDifferenceLayer = dynamic(
  () => import("./layers/TemperatureDifferenceLayer"),
  {
    ssr: false,
    loading: () => <div style={{ width: "100%", height: "100%" }} />,
  }
);

const MslContoursLayer = dynamic(() => import("./layers/MslContoursLayer"), {
  ssr: false,
  loading: () => <div style={{ width: "100%", height: "100%" }} />,
});

const WindTrailParticlesLayer = dynamic(() => import("./layers/WindTrailParticlesLayer"), {
  ssr: false,
  loading: () => <div style={{ width: "100%", height: "100%" }} />,
});

const BackwardTrajectoryLayer = dynamic(
  () => import("./layers/BackwardTrajectoryLayer"),
  {
    ssr: false,
    loading: () => <div style={{ width: "100%", height: "100%" }} />,
  }
);

const TrajectorySteeringLayer = dynamic(
  () => import("./layers/TrajectorySteeringLayer"),
  {
    ssr: false,
    loading: () => <div style={{ width: "100%", height: "100%" }} />,
  }
);

const UpperAirSupportLayer = dynamic(
  () => import("./layers/UpperAirSupportLayer"),
  {
    ssr: false,
    loading: () => <div style={{ width: "100%", height: "100%" }} />,
  }
);

const TimeSlider = dynamic(() => import("./TimeSlider"), {
  ssr: false,
  loading: () => <div style={{ height: "100%" }} />,
});

export default function HomeClient() {
  const [datehour, setDatehour] = useState(() => "2021-11-12T03:00");
  const [allReady, setAllReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [layerInfoOpen, setLayerInfoOpen] = useState(true);
  const sidebarWidth = "max(15vw, 320px)";
  const layerInfoWidth = sidebarWidth;

  return (
    <div
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#04070d",
      }}
    >
      <Analytics />

      <div
        style={{
          position: "absolute",
          inset: 0,
        }}
      >
        <EarthBase
          timestamp={datehour}
          onAllReadyChange={(ready, timestamp) => {
            // only accept readiness for the currently displayed timestamp
            if (timestamp === datehour) setAllReady(ready);
          }}
        >
          <MoistureTransportLayer />
          <EvaporationLayer />
          <IVTLayer />
          <PotentialVorticityLayer />
          <DivergenceLayer />
          <VerticalVelocityLayer />
          <TemperatureLayer />
          <TemperatureDifferenceLayer />
          <MslContoursLayer />
          <TrajectorySteeringLayer />
          <UpperAirSupportLayer />
          <BackwardTrajectoryLayer />
          <WindTrailParticlesLayer heightTex={null} />
        </EarthBase>
      </div>

      <div
        style={{
          position: "absolute",
          left: 24,
          right: 24,
          bottom: 24,
          zIndex: 35,
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            width: "min(960px, 100%)",
            pointerEvents: "auto",
          }}
        >
          <TimeSlider
            value={datehour}
            onChange={(next) => {
              setAllReady(false);
              setDatehour(next);
            }}
            allReady={allReady}
          />
        </div>
      </div>

      <button
        onClick={() => setSidebarOpen((v) => !v)}
        aria-label={sidebarOpen ? "Close layers" : "Open layers"}
        style={{
          position: "absolute",
          top: 14,
          left: sidebarOpen ? `calc(${sidebarWidth} - 48px)` : 14,
          zIndex: 50,
          width: sidebarOpen ? 34 : 100,
          height: sidebarOpen ? 34 : 50,
          borderRadius: 12,
          background: "rgba(70, 140, 255, 0.24)",
          border: "1px solid rgba(140, 190, 255, 0.32)",

          color: "white",
          cursor: "pointer",
          backdropFilter: "blur(10px)",
          display: "grid",
          placeItems: "center",
          userSelect: "none",
          boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
          transition:
            "left 220ms cubic-bezier(0.2, 0.8, 0.2, 1), width 220ms cubic-bezier(0.2, 0.8, 0.2, 1), height 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        }}
      >
        <span style={{ fontSize: sidebarOpen ? 22 : 14, fontWeight: 600, lineHeight: 1, opacity: 0.95 }}>
          {sidebarOpen ? "×" : "Layers"}
        </span>
      </button>

      <aside
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: sidebarWidth,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          backdropFilter: "blur(6px)",
          background: "transparent",
          borderRight: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "20px 0 40px rgba(0,0,0,0.25)",
          transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)",
          opacity: sidebarOpen ? 1 : 0,
          transition: "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 180ms ease",
          zIndex: 45,
          pointerEvents: sidebarOpen ? "auto" : "none",
        }}
      >
        <SidebarPane />
      </aside>

      <button
        onClick={() => setLayerInfoOpen((v) => !v)}
        aria-label={layerInfoOpen ? "Close layer info" : "Open layer info"}
        style={{
          position: "absolute",
          top: 14,
          right: 14,
          zIndex: 50,
          width: layerInfoOpen ? 34 : 114,
          height: layerInfoOpen ? 34 : 50,
          borderRadius: 12,
          background: "rgba(70, 140, 255, 0.24)",
          border: "1px solid rgba(140, 190, 255, 0.32)",
          color: "white",
          cursor: "pointer",
          backdropFilter: "blur(10px)",
          display: "grid",
          placeItems: "center",
          userSelect: "none",
          boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
          transition:
            "width 220ms cubic-bezier(0.2, 0.8, 0.2, 1), height 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        }}
      >
        <span style={{ fontSize: layerInfoOpen ? 22 : 14, fontWeight: 600, lineHeight: 1, opacity: 0.95 }}>
          {layerInfoOpen ? "×" : "Layer Info"}
        </span>
      </button>

      <aside
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: layerInfoWidth,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          backdropFilter: "blur(6px)",
          background: "transparent",
          borderLeft: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "-20px 0 40px rgba(0,0,0,0.25)",
          transform: layerInfoOpen ? "translateX(0)" : "translateX(100%)",
          opacity: layerInfoOpen ? 1 : 0,
          transition: "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 180ms ease",
          zIndex: 45,
          pointerEvents: layerInfoOpen ? "auto" : "none",
        }}
      >
        <LayerInfoPane />
      </aside>
    </div>
  );
}
