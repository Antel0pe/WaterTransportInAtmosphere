"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Analytics } from "@vercel/analytics/next";
import SidebarPane from "./sidebar/SidebarPane";

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

const WindUVArrowsLayer = dynamic(() => import("./layers/WindUVArrowsLayer"), {
  ssr: false,
  loading: () => <div style={{ width: "100%", height: "100%" }} />,
});

const TestWindLayer = dynamic(() => import("./layers/TestWindLayer"), {
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

const TimeSlider = dynamic(() => import("./TimeSlider"), {
  ssr: false,
  loading: () => <div style={{ height: "100%" }} />,
});

export default function HomeClient() {
  const [datehour, setDatehour] = useState(() => "2021-11-12T03:00");
  const [allReady, setAllReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
      }}
    >
      <Analytics />

      {/* Main content column */}
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        <div style={{ flex: "0 0 80%", position: "relative", minHeight: 0 }}>
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
            <BackwardTrajectoryLayer />
            {/* <WindUVArrowsLayer /> */}
            <WindTrailParticlesLayer heightTex={null} />
            {/* <TestWindLayer /> */}
          </EarthBase>
        </div>

        <div
          style={{
            flex: "0 0 20%",
            borderTop: "1px solid rgba(0,0,0,0.1)",
            minHeight: 0,
          }}
        >
          <TimeSlider
            value={datehour}
            onChange={(next) => {
              setAllReady(false);  // immediately block until new time renders
              setDatehour(next);
            }}
            allReady={allReady}
          />
        </div>
      </div>

      {/* Sidebar */}
      {/* <aside
        style={{
          flex: "0 0 25%",
          width: "25%",
          minWidth: 0,
          height: "100%",
          borderLeft: "1px solid rgba(255,255,255,0.1)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          backdropFilter: "blur(6px)",
          background: "rgba(18,18,20,0.55)",
        }}
      >
        <SidebarPane />
      </aside> */}
      {/* Top-right toggle button */}
      <button
        onClick={() => setSidebarOpen((v) => !v)}
        aria-label={sidebarOpen ? "Close info" : "Open info"}
        style={{
          position: "absolute",
          top: 14,
          right: 14,
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
        }}
      >
        <span style={{ fontSize: sidebarOpen ? 22 : 14, fontWeight: 600, lineHeight: 1, opacity: 0.95 }}>
          {sidebarOpen ? "×" : "Explain"}
        </span>
      </button>


      {/* Optional: click-away scrim when open */}
      {/* <div
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 40,
          pointerEvents: sidebarOpen ? "auto" : "none",
        }}
      /> */}

      {/* Sidebar overlay drawer */}
      {/* <aside
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          height: "100%",
          width: 420,
          maxWidth: "92vw", // prevents weirdness on small screens
          zIndex: 45,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          backdropFilter: "blur(6px)",
          background: "rgba(18,18,20,0.55)",
          borderLeft: "1px solid rgba(255,255,255,0.12)",
          transform: sidebarOpen ? "translateX(0)" : "translateX(110%)",
          transition: "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
          boxShadow: "0 0 0 rgba(0,0,0,0)", // optional
        }}
      >
        <SidebarPane />
      </aside> */}
      {/* Sidebar (dock-right, pushes content) */}
      <aside
        style={{
          flex: "0 0 auto",
          width: sidebarOpen ? 420 : 0,
          maxWidth: "92vw",
          height: "100%",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          backdropFilter: "blur(6px)",
          background: "rgba(18,18,20,0.55)",
          borderLeft: sidebarOpen ? "1px solid rgba(255,255,255,0.12)" : "none",
          transition: "width 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
          pointerEvents: sidebarOpen ? "auto" : "none",
        }}
      >
        {/* only mount when open (optional, avoids tweakpane weirdness when hidden) */}
        {sidebarOpen ? <SidebarPane /> : null}
      </aside>

    </div>
  );
}
