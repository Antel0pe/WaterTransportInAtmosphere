"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useControls, type LayerToggles } from "@/app/state/controlsStore";

type ActiveLayerId =
  | keyof LayerToggles
  | "pv"
  | "divergence"
  | "verticalVelocity"
  | "temperature"
  | "temperatureDifference"
  | "contours"
  | "windTrails";

type LegendKind = "fill" | "line" | "dot" | "ring" | "pulse" | "trail" | "marker";

type LegendItem = {
  kind: LegendKind;
  swatch: string;
  accent?: string;
  label: string;
  detail: string;
};

type LayerInfoEntry = {
  id: ActiveLayerId;
  title: string;
  tag?: string;
  summary: string;
  detail: string;
  legend: LegendItem[];
};

type LayerInfoTemplate = Omit<LayerInfoEntry, "tag">;
type ControlsStateSnapshot = ReturnType<typeof useControls.getState>;

function fillLegend(label: string, detail: string, swatch: string): LegendItem {
  return { kind: "fill", label, detail, swatch };
}

function lineLegend(label: string, detail: string, swatch: string): LegendItem {
  return { kind: "line", label, detail, swatch };
}

function dotLegend(label: string, detail: string, swatch: string): LegendItem {
  return { kind: "dot", label, detail, swatch };
}

function ringLegend(
  label: string,
  detail: string,
  swatch: string,
  accent?: string
): LegendItem {
  return { kind: "ring", label, detail, swatch, accent };
}

function pulseLegend(
  label: string,
  detail: string,
  swatch: string,
  accent?: string
): LegendItem {
  return { kind: "pulse", label, detail, swatch, accent };
}

function trailLegend(label: string, detail: string, swatch: string): LegendItem {
  return { kind: "trail", label, detail, swatch };
}

function markerLegend(label: string, detail: string, swatch: string): LegendItem {
  return { kind: "marker", label, detail, swatch };
}

const LAYER_INFO: Record<ActiveLayerId, LayerInfoTemplate> = {
  moisture: {
    id: "moisture",
    title: "Moisture",
    summary:
      "This layer shows positive moisture anomaly only. It appears where the total-column moisture signal rises above the display threshold, so blank areas simply mean the anomaly is weak or filtered out.",
    detail: "",
    legend: [
      fillLegend(
        "Deep violet",
        "A positive anomaly is present, but it is still on the weaker side of the displayed plume.",
        "linear-gradient(135deg, rgba(51, 0, 89, 0.95), rgba(123, 16, 179, 0.86))"
      ),
      fillLegend(
        "Bright magenta",
        "The moisture corridor is stronger and more concentrated here.",
        "linear-gradient(135deg, rgba(191, 48, 255, 0.96), rgba(255, 94, 228, 0.88))"
      ),
      fillLegend(
        "Pink-white core",
        "This marks the most intense moisture anomaly in the current frame.",
        "linear-gradient(135deg, rgba(255, 214, 255, 0.98), rgba(255, 255, 255, 0.96))"
      ),
    ],
  },
  evaporation: {
    id: "evaporation",
    title: "Evaporation",
    summary:
      "This layer maps positive evaporation anomaly at the surface. It behaves like a source-region overlay: only positive values above the threshold are drawn, so the field appears in shades of red rather than a full two-sided palette.",
    detail:
      "Use it to spot where the ocean is contributing moisture into the event. Darker reds are modest source regions, while brighter reds are the strongest evaporation signal.",
    legend: [
      fillLegend(
        "Faint red",
        "A weaker positive evaporation anomaly is present.",
        "linear-gradient(135deg, rgba(87, 0, 0, 0.48), rgba(160, 0, 0, 0.7))"
      ),
      fillLegend(
        "Saturated red",
        "Stronger evaporation anomaly and a more active moisture source region.",
        "linear-gradient(135deg, rgba(173, 0, 0, 0.92), rgba(255, 72, 58, 0.84))"
      ),
    ],
  },
  ivt: {
    id: "ivt",
    title: "Integrated Vapor Transport",
    summary:
      "This layer shows integrated vapor transport, the total horizontal movement of water vapor through the atmospheric column.",
    detail: "",
    legend: [
      fillLegend(
        "Dark green",
        "A transport corridor is present, but it is still comparatively weak.",
        "linear-gradient(135deg, rgba(0, 66, 0, 0.88), rgba(0, 112, 22, 0.84))"
      ),
      fillLegend(
        "Bright green",
        "The strongest integrated vapor transport corridor in the view.",
        "linear-gradient(135deg, rgba(0, 180, 34, 0.92), rgba(121, 255, 121, 0.9))"
      ),
    ],
  },
  backwardTrajectory: {
    id: "backwardTrajectory",
    title: "Backward Trajectory",
    summary:
      "This layer reconstructs where the selected parcel path came from and adds context around moisture change, forward ghost cells, and local geopotential-height structure.",
    detail:
      "The pale path is the trajectory itself. The colored dots and overlays answer different questions: whether the parcel was gaining or losing moisture, where ghost-forward cells land, and how the surrounding height field is arranged.",
    legend: [
      lineLegend(
        "Pale path line",
        "The main backward trajectory traced through earlier hours.",
        "linear-gradient(90deg, rgba(124, 198, 255, 0.72), rgba(229, 244, 255, 0.96))"
      ),
      dotLegend(
        "Red parcel dots",
        "Steps where evaporation exceeds precipitation, indicating moisture gain along the path.",
        "linear-gradient(135deg, rgba(255, 74, 58, 0.96), rgba(255, 135, 93, 0.86))"
      ),
      dotLegend(
        "Blue parcel dots",
        "Steps where precipitation outweighs local evaporation, indicating moisture loss along the path.",
        "linear-gradient(135deg, rgba(32, 92, 255, 0.96), rgba(124, 198, 255, 0.86))"
      ),
      ringLegend(
        "Yellow highlight halo",
        "The currently emphasized parcel position along the path.",
        "rgba(255, 211, 0, 0.95)",
        "rgba(255, 211, 0, 0.42)"
      ),
      trailLegend(
        "Yellow / green ghost trails",
        "Forward-advected ghost cells. Yellow is the static ghost branch; green is the time-varying branch.",
        "linear-gradient(90deg, rgba(249, 213, 72, 0.96), rgba(91, 217, 106, 0.9))"
      ),
      lineLegend(
        "Blue-gray-red contours",
        "Geopotential-height context. Lower heights plot bluer, higher heights plot redder; closed extrema can also appear as lightly filled patches.",
        "linear-gradient(90deg, rgba(32, 92, 255, 0.95), rgba(139, 139, 139, 0.82), rgba(255, 74, 58, 0.95))"
      ),
    ],
  },
  trajectorySteering: {
    id: "trajectorySteering",
    title: "Trajectory Steering",
    summary:
      "This layer shows the larger-scale steering setup that helps guide where the trajectories and moisture corridor organize.",
    detail:
      "It helps explain why the pathway bends and clusters the way it does: the background field shows the steering regime, the contours show the surrounding height structure, and the gold ribbon / pulse highlights the strongest steering gradient band.",
    legend: [
      fillLegend(
        "Blue field",
        "The colder [temperature] side of the steering environment.",
        "linear-gradient(135deg, rgba(53, 108, 255, 0.96), rgba(143, 215, 255, 0.88))"
      ),
      fillLegend(
        "Off-white field",
        "Near-neutral [temperature] values in the steering environment.",
        "linear-gradient(135deg, rgba(247, 241, 230, 0.98), rgba(236, 233, 226, 0.9))"
      ),
      fillLegend(
        "Orange-red field",
        "The warmer [temperature] side of the steering environment.",
        "linear-gradient(135deg, rgba(255, 211, 138, 0.95), rgba(255, 88, 78, 0.88))"
      ),
      lineLegend(
        "Contour lines",
        "Each line is an equal geopotential-height contour. Cooler-colored lines are relatively lower; warmer-colored lines are relatively higher.",
        "linear-gradient(90deg, rgba(143, 215, 255, 0.95), rgba(244, 240, 232, 0.92), rgba(255, 211, 138, 0.95))"
      ),
      pulseLegend(
        "Gold ribbon / pulse",
        "Highlights stronger gradient bands in the steering corridor.",
        "rgba(255, 226, 168, 0.95)",
        "rgba(255, 226, 168, 0.36)"
      ),
    ],
  },
  upperAirStackedStructure: {
    id: "upperAirStackedStructure",
    title: "Upper Air Stacked Structure",
    summary:
      "This layer lines up the main upper-level support signals behind the event: 500 hPa ascent, 250 hPa divergence, potential vorticity, and the surrounding 250 hPa trough geometry.",
    detail:
      "It is meant to show why the event is dynamically supported aloft: notice how the PV feature and 250 hPa trough geometry line up with the 250 hPa divergence pulse, while the 500 hPa ascent field sits underneath that upper-level support.",
    legend: [
      fillLegend(
        "Salmon to red field",
        "500 hPa ascent. More saturated red means a stronger upward-motion signal.",
        "linear-gradient(135deg, rgba(255, 216, 202, 0.96), rgba(255, 90, 82, 0.88))"
      ),
      pulseLegend(
        "Pale gold pulse",
        "250 hPa divergence support. The pulsing glow marks where upper-level divergence is strongest.",
        "rgba(255, 239, 184, 0.96)",
        "rgba(255, 239, 184, 0.42)"
      ),
      fillLegend(
        "Blue-white-brown PV shading",
        "Potential vorticity field. Lower values are bluer, middle values go pale, and higher values shift into orange-brown.",
        "linear-gradient(135deg, rgba(18, 43, 122, 0.96), rgba(242, 242, 235, 0.92), rgba(148, 33, 20, 0.9))"
      ),
      lineLegend(
        "Green to magenta contours",
        "Equal geopotential-height contours laid over the upper-air story view.",
        "linear-gradient(90deg, rgba(0, 255, 38, 0.95), rgba(255, 0, 89, 0.95))"
      ),
      markerLegend(
        "Trough marker",
        "Marks the diagnosed 250 hPa trough position that anchors the upper-level setup.",
        "linear-gradient(135deg, rgba(255, 216, 149, 0.98), rgba(255, 163, 92, 0.88))"
      ),
    ],
  },
  pv: {
    id: "pv",
    title: "Potential Vorticity",
    summary:
      "This layer shows potential vorticity at the selected pressure level.",
    detail: "",
    legend: [
      fillLegend(
        "Blue PV shading",
        "Lower values in the displayed PV range.",
        "linear-gradient(135deg, rgba(18, 43, 122, 0.96), rgba(43, 133, 217, 0.88))"
      ),
      fillLegend(
        "Pale neutral shading",
        "Mid-range PV values in the current view.",
        "linear-gradient(135deg, rgba(242, 242, 235, 0.98), rgba(226, 221, 205, 0.9))"
      ),
      fillLegend(
        "Orange-brown shading",
        "Higher PV values in the displayed range.",
        "linear-gradient(135deg, rgba(219, 110, 46, 0.94), rgba(148, 33, 20, 0.9))"
      ),
    ],
  },
  divergence: {
    id: "divergence",
    title: "Divergence",
    summary:
      "This layer shows horizontal divergence at the selected pressure level.",
    detail: "",
    legend: [
      fillLegend(
        "Green",
        "Negative divergence / convergence. Stronger green means a stronger convergent signal.",
        "linear-gradient(135deg, rgba(54, 165, 68, 0.9), rgba(31, 199, 71, 0.9))"
      ),
      fillLegend(
        "Near-white",
        "Little net divergence signal or values close to neutral.",
        "linear-gradient(135deg, rgba(221, 230, 255, 0.98), rgba(246, 248, 255, 0.92))"
      ),
      fillLegend(
        "Yellow",
        "Positive divergence. Stronger yellow means a stronger positive signal.",
        "linear-gradient(135deg, rgba(255, 234, 122, 0.94), rgba(255, 217, 26, 0.9))"
      ),
    ],
  },
  verticalVelocity: {
    id: "verticalVelocity",
    title: "Vertical Velocity",
    summary:
      "This layer shows vertical motion at the selected pressure level.",
    detail: "",
    legend: [
      fillLegend(
        "Teal",
        "Stronger descent in the displayed vertical-velocity field.",
        "linear-gradient(135deg, rgba(154, 240, 228, 0.94), rgba(26, 204, 184, 0.9))"
      ),
      fillLegend(
        "Near-white",
        "Weak vertical motion or values close to zero.",
        "linear-gradient(135deg, rgba(255, 255, 255, 0.98), rgba(230, 236, 246, 0.92))"
      ),
      fillLegend(
        "Red",
        "Stronger ascent in the displayed vertical-velocity field.",
        "linear-gradient(135deg, rgba(255, 138, 138, 0.94), rgba(255, 20, 20, 0.9))"
      ),
    ],
  },
  temperature: {
    id: "temperature",
    title: "Temperature",
    summary:
      "This layer shows temperature at the selected pressure level.",
    detail: "",
    legend: [
      fillLegend(
        "Cooler colors",
        "Colder air in the displayed temperature range.",
        "linear-gradient(135deg, rgba(13, 46, 217, 0.95), rgba(13, 166, 242, 0.88))"
      ),
      fillLegend(
        "Neutral colors",
        "Middle of the displayed temperature range.",
        "linear-gradient(135deg, rgba(235, 247, 250, 0.98), rgba(250, 235, 128, 0.88))"
      ),
      fillLegend(
        "Warmer colors",
        "Warmer air in the displayed temperature range.",
        "linear-gradient(135deg, rgba(235, 46, 26, 0.95), rgba(153, 0, 26, 0.92))"
      ),
    ],
  },
  temperatureDifference: {
    id: "temperatureDifference",
    title: "Temperature Difference",
    summary:
      "This layer shows temperature change from the previous frame at the selected pressure level.",
    detail: "",
    legend: [
      fillLegend(
        "Blue",
        "Cooling relative to the previous frame.",
        "linear-gradient(135deg, rgba(31, 107, 242, 0.95), rgba(76, 159, 255, 0.9))"
      ),
      fillLegend(
        "White",
        "Little temperature change between the two frames.",
        "linear-gradient(135deg, rgba(242, 247, 255, 0.98), rgba(255, 255, 255, 0.94))"
      ),
      fillLegend(
        "Red",
        "Warming relative to the previous frame.",
        "linear-gradient(135deg, rgba(235, 82, 82, 0.95), rgba(235, 31, 31, 0.92))"
      ),
    ],
  },
  contours: {
    id: "contours",
    title: "Contours",
    summary:
      "Contours are lines of equal geopotential height.",
    detail: "",
    legend: [
      lineLegend(
        "Contour line",
        "Each line connects points of equal geopotential height.",
        "linear-gradient(90deg, rgba(244, 244, 244, 0.95), rgba(200, 200, 200, 0.85))"
      ),
      lineLegend(
        "Green contour",
        "Relatively lower geopotential-height contour values in the current set.",
        "linear-gradient(90deg, rgba(0, 255, 38, 0.95), rgba(80, 255, 120, 0.85))"
      ),
      lineLegend(
        "Pink-red contour",
        "Relatively higher geopotential-height contour values in the current set.",
        "linear-gradient(90deg, rgba(255, 48, 122, 0.95), rgba(255, 0, 89, 0.92))"
      ),
    ],
  },
  windTrails: {
    id: "windTrails",
    title: "Wind Trails",
    summary:
      "Wind trails show the wind pathway at the selected level.",
    detail: "",
    legend: [
      trailLegend(
        "Cyan trail",
        "The wind pathway itself.",
        "linear-gradient(90deg, rgba(65, 214, 214, 0.7), rgba(153, 255, 255, 0.96))"
      ),
    ],
  },
};

function formatPressureTag(value: number | string) {
  if (value === "msl") return "MSL";
  if (value === "none") return undefined;
  return `${value} hPa`;
}

function buildActiveLayerEntries(visibility: {
  layers: LayerToggles;
  pvPressureLevel: number | string;
  divergencePressureLevel: number | string;
  verticalVelocityPressureLevel: number | string;
  temperaturePressureLevel: number | string;
  temperatureDiffPressureLevel: number | string;
  contoursPressure: number | string;
  windTrailsPressure: number | string;
}) {
  const entries: LayerInfoEntry[] = [];

  const pushIf = (enabled: boolean, id: ActiveLayerId, tag?: string) => {
    if (!enabled) return;
    entries.push({
      ...LAYER_INFO[id],
      tag,
    });
  };

  pushIf(visibility.layers.backwardTrajectory, "backwardTrajectory");
  pushIf(visibility.layers.trajectorySteering, "trajectorySteering");
  pushIf(visibility.layers.upperAirStackedStructure, "upperAirStackedStructure");
  pushIf(visibility.layers.moisture, "moisture");
  pushIf(visibility.layers.evaporation, "evaporation");
  pushIf(visibility.layers.ivt, "ivt");
  pushIf(visibility.pvPressureLevel !== "none", "pv", formatPressureTag(visibility.pvPressureLevel));
  pushIf(
    visibility.divergencePressureLevel !== "none",
    "divergence",
    formatPressureTag(visibility.divergencePressureLevel)
  );
  pushIf(
    visibility.verticalVelocityPressureLevel !== "none",
    "verticalVelocity",
    formatPressureTag(visibility.verticalVelocityPressureLevel)
  );
  pushIf(
    visibility.temperaturePressureLevel !== "none",
    "temperature",
    formatPressureTag(visibility.temperaturePressureLevel)
  );
  pushIf(
    visibility.temperatureDiffPressureLevel !== "none",
    "temperatureDifference",
    formatPressureTag(visibility.temperatureDiffPressureLevel)
  );
  pushIf(
    visibility.contoursPressure !== "none",
    "contours",
    formatPressureTag(visibility.contoursPressure)
  );
  pushIf(
    visibility.windTrailsPressure !== "none",
    "windTrails",
    formatPressureTag(visibility.windTrailsPressure)
  );

  return entries;
}

function getActiveLayerIdsFromState(state: ControlsStateSnapshot) {
  return buildActiveLayerEntries({
    layers: state.layers,
    pvPressureLevel: state.pv.pressureLevel,
    divergencePressureLevel: state.divergence.pressureLevel,
    verticalVelocityPressureLevel: state.verticalVelocity.pressureLevel,
    temperaturePressureLevel: state.temperature.pressureLevel,
    temperatureDiffPressureLevel: state.temperatureDifference.pressureLevel,
    contoursPressure: state.contoursPressure,
    windTrailsPressure: state.windTrailsPressure,
  }).map((layer) => layer.id);
}

export default function LayerInfoPane() {
  const layers = useControls((state) => state.layers);
  const pvPressureLevel = useControls((state) => state.pv.pressureLevel);
  const divergencePressureLevel = useControls((state) => state.divergence.pressureLevel);
  const verticalVelocityPressureLevel = useControls(
    (state) => state.verticalVelocity.pressureLevel
  );
  const temperaturePressureLevel = useControls((state) => state.temperature.pressureLevel);
  const temperatureDiffPressureLevel = useControls(
    (state) => state.temperatureDifference.pressureLevel
  );
  const contoursPressure = useControls((state) => state.contoursPressure);
  const windTrailsPressure = useControls((state) => state.windTrailsPressure);

  const computedActiveLayers = useMemo(
    () =>
      buildActiveLayerEntries({
        layers,
        pvPressureLevel,
        divergencePressureLevel,
        verticalVelocityPressureLevel,
        temperaturePressureLevel,
        temperatureDiffPressureLevel,
        contoursPressure,
        windTrailsPressure,
      }),
    [
      contoursPressure,
      divergencePressureLevel,
      layers,
      pvPressureLevel,
      temperatureDiffPressureLevel,
      temperaturePressureLevel,
      verticalVelocityPressureLevel,
      windTrailsPressure,
    ]
  );
  const [layerOrder, setLayerOrder] = useState<ActiveLayerId[]>(() =>
    getActiveLayerIdsFromState(useControls.getState())
  );
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    return useControls.subscribe(getActiveLayerIdsFromState, (nextActiveIds) => {
      setLayerOrder((prev) => {
        const retained = prev.filter((id) => nextActiveIds.includes(id));
        const additions = nextActiveIds.filter((id) => !prev.includes(id));
        const nextOrder = [...additions, ...retained];

        if (
          nextOrder.length === prev.length &&
          nextOrder.every((id, index) => id === prev[index])
        ) {
          return prev;
        }

        return nextOrder;
      });
    });
  }, []);

  const activeLayers = useMemo(() => {
    const byId = new Map(computedActiveLayers.map((layer) => [layer.id, layer]));
    return layerOrder
      .map((id) => byId.get(id))
      .filter((layer): layer is LayerInfoEntry => Boolean(layer));
  }, [computedActiveLayers, layerOrder]);

  return (
    <aside
      style={{
        position: "relative",
        top: 0,
        right: 0,
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backdropFilter: "blur(6px)",
        background: "transparent",
        borderLeft: "1px solid rgba(255,255,255,0.08)",
        zIndex: 1000,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <section style={panelStyle({ paddingRight: 56 })}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              opacity: 0.72,
            }}
          >
            Layer Info
          </div>
        </section>

        {activeLayers.map((layer) => {
          const isOpen = openSections[layer.id] ?? true;

          return (
            <section key={layer.id} style={panelStyle()}>
              <button
                onClick={() =>
                  setOpenSections((prev) => ({
                    ...prev,
                    [layer.id]: !(prev[layer.id] ?? true),
                  }))
                }
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  padding: 0,
                  textAlign: "left",
                  marginBottom: isOpen ? 12 : 0,
                }}
              >
                <div style={{ minWidth: 0, display: "grid", gap: 6 }}>
                  <div style={sectionTitleStyle()}>{layer.title}</div>
                  {layer.tag ? <div style={tagStyle()}>{layer.tag}</div> : null}
                </div>
                <span style={{ opacity: 0.7, fontSize: 18, lineHeight: 1 }}>
                  {isOpen ? "–" : "+"}
                </span>
              </button>

              {isOpen ? (
                <div style={{ display: "grid", gap: 12 }}>
                  <div style={{ display: "grid", gap: 8 }}>
                    {layer.legend.map((item) => (
                      <div
                        key={`${layer.id}-${item.label}`}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "16px 1fr",
                          gap: 10,
                          alignItems: "start",
                        }}
                      >
                        {renderLegendGlyph(item)}
                        <div style={{ display: "grid", gap: 2 }}>
                          <div style={{ fontSize: 12, fontWeight: 600 }}>{item.label}</div>
                          <div style={mutedTextStyle()}>{item.detail}</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {layer.summary ? <div style={bodyTextStyle()}>{layer.summary}</div> : null}
                  {layer.detail ? <div style={bodyTextStyle()}>{layer.detail}</div> : null}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function panelStyle(overrides?: CSSProperties) {
  return {
    ...basePanelStyle(),
    ...overrides,
  };
}

function basePanelStyle() {
  return {
    margin: 8,
    padding: 12,
    borderRadius: 12,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.08)",
    color: "#e9eef7",
    font: "500 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto",
  } satisfies CSSProperties;
}

function bodyTextStyle() {
  return {
    opacity: 0.84,
    fontWeight: 400,
    lineHeight: 1.5,
  } as const;
}

function mutedTextStyle() {
  return {
    opacity: 0.72,
    fontWeight: 400,
    lineHeight: 1.45,
  } as const;
}

function sectionTitleStyle() {
  return {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: ".02em",
    textTransform: "uppercase" as const,
    opacity: 0.92,
  };
}

function tagStyle() {
  return {
    display: "inline-flex",
    width: "fit-content",
    padding: "4px 8px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.05)",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: ".02em",
    opacity: 0.82,
  } as const;
}

function renderLegendGlyph(item: LegendItem) {
  const frameStyle: CSSProperties = {
    position: "relative",
    width: 16,
    height: 16,
    marginTop: 2,
  };

  const borderColor = item.accent ?? "rgba(255,255,255,0.14)";

  if (item.kind === "line") {
    return (
      <span aria-hidden style={frameStyle}>
        <span
          style={{
            position: "absolute",
            top: 7,
            left: 1,
            right: 1,
            height: 3,
            borderRadius: 999,
            background: item.swatch,
            boxShadow: "0 0 0 1px rgba(255,255,255,0.08)",
          }}
        />
      </span>
    );
  }

  if (item.kind === "trail") {
    return (
      <span aria-hidden style={frameStyle}>
        <span
          style={{
            position: "absolute",
            top: 4,
            left: 1,
            right: 1,
            height: 3,
            borderRadius: 999,
            background: item.swatch,
            opacity: 0.68,
            transform: "rotate(14deg)",
            transformOrigin: "center",
          }}
        />
        <span
          style={{
            position: "absolute",
            top: 8,
            left: 2,
            right: 0,
            height: 3,
            borderRadius: 999,
            background: item.swatch,
            transform: "rotate(-12deg)",
            transformOrigin: "center",
          }}
        />
      </span>
    );
  }

  if (item.kind === "dot" || item.kind === "marker") {
    return (
      <span aria-hidden style={frameStyle}>
        <span
          style={{
            position: "absolute",
            inset: item.kind === "marker" ? 2 : 3,
            borderRadius: 999,
            background: item.swatch,
            boxShadow:
              item.kind === "marker"
                ? "0 0 0 3px rgba(255,255,255,0.12)"
                : "inset 0 0 0 1px rgba(255,255,255,0.1)",
          }}
        />
      </span>
    );
  }

  if (item.kind === "ring" || item.kind === "pulse") {
    return (
      <span aria-hidden style={frameStyle}>
        <span
          style={{
            position: "absolute",
            inset: item.kind === "pulse" ? 1 : 2,
            borderRadius: 999,
            border: `2px solid ${borderColor}`,
            opacity: item.kind === "pulse" ? 0.68 : 0.92,
            boxShadow:
              item.kind === "pulse"
                ? `0 0 10px ${item.accent ?? "rgba(255,255,255,0.28)"}`
                : "none",
          }}
        />
        <span
          style={{
            position: "absolute",
            inset: item.kind === "pulse" ? 5 : 6,
            borderRadius: 999,
            background: item.swatch,
          }}
        />
      </span>
    );
  }

  return (
    <span
      aria-hidden
      style={{
        ...frameStyle,
        borderRadius: 999,
        background: item.swatch,
        boxShadow: `inset 0 0 0 1px ${borderColor}`,
      }}
    />
  );
}
