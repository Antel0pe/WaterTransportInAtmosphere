import { fetchJsonOrThrow } from "./dataFetchErrors";

const DATA_SOURCE_KIND = process.env.NEXT_PUBLIC_DATA_SOURCE_KIND;
const PUBLIC_DATA_BASE_PATH = process.env.NEXT_PUBLIC_DATA_BASE_PATH?.trim() || "";

function usesPublicDataAssets() {
  return DATA_SOURCE_KIND === "public";
}

function buildPublicDataUrl(...segments: string[]) {
  const prefix = PUBLIC_DATA_BASE_PATH.replace(/^\/+|\/+$/g, "");
  return `/${[prefix, ...segments].filter(Boolean).join("/")}`;
}

function parseDatehour(datehour: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(datehour);
  if (!match) throw new Error("Invalid datehour");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error("Invalid datehour");
  }

  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day ||
    dt.getUTCHours() !== hour ||
    dt.getUTCMinutes() !== minute
  ) {
    throw new Error("Invalid datehour");
  }

  return dt;
}

function snapToHour(dt: Date): Date {
  return new Date(
    Date.UTC(
      dt.getUTCFullYear(),
      dt.getUTCMonth(),
      dt.getUTCDate(),
      dt.getUTCHours(),
      0,
      0,
      0
    )
  );
}

function toHourlyPngFilename(datehour: string) {
  const dtHourly = snapToHour(parseDatehour(datehour));
  const y = dtHourly.getUTCFullYear();
  const mo = String(dtHourly.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dtHourly.getUTCDate()).padStart(2, "0");
  const h = String(dtHourly.getUTCHours()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}-00-00.png`;
}

function toHourlyJsonFilename(datehour: string) {
  const dtHourly = snapToHour(parseDatehour(datehour));
  const y = dtHourly.getUTCFullYear();
  const mo = String(dtHourly.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dtHourly.getUTCDate()).padStart(2, "0");
  const h = String(dtHourly.getUTCHours()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}-00-00.json`;
}

export function evaporationApiUrl(datehour: string) {
  if (usesPublicDataAssets()) {
    return buildPublicDataUrl(
      "evap_rgb_instant_clim_anom",
      toHourlyPngFilename(datehour)
    );
  }

  return `/api/evaporation/${encodeURIComponent(datehour)}`;
}

export function totalColumnWaterApiUrl(datehour: string) {
  if (usesPublicDataAssets()) {
    return buildPublicDataUrl(
      "waterTransport-evap-precip-waterColumn",
      toHourlyPngFilename(datehour)
    );
  }

  return `/api/total_column_water/${encodeURIComponent(datehour)}`;
}

export function ivtApiUrl(datehour: string) {
  if (usesPublicDataAssets()) {
    return buildPublicDataUrl("ivt-925-1000", toHourlyPngFilename(datehour));
  }

  return `/api/ivt/${encodeURIComponent(datehour)}`;
}

export type ContoursPressure = "msl" | "250" | "500" | "925";

export function mslContoursApiUrl(datehour: string, pressure: ContoursPressure) {
  if (usesPublicDataAssets()) {
    return buildPublicDataUrl(
      "gph_contours",
      String(pressure),
      toHourlyJsonFilename(datehour)
    );
  }

  return `/api/msl_contours/${encodeURIComponent(String(pressure))}/${encodeURIComponent(datehour)}`;
}

export type LonLat = [number, number];
export type ContourLine = LonLat[];
export type ContourLevels = Record<string, ContourLine[]>;

export type MslContoursFile = {
  timestamp: string; // "2021-12-13T00:00:00"
  contour_step_hpa: number;
  levels: ContourLevels; // keys like "960.0"
};

export async function fetchMslContours(
  datehour: string,
  pressure: ContoursPressure
): Promise<MslContoursFile> {
  const layerLabel =
    pressure === "msl" ? "Sea-level pressure contours" : `${pressure} hPa contours`;

  return fetchJsonOrThrow<MslContoursFile>(
    mslContoursApiUrl(datehour, pressure),
    "Failed to load contour data.",
    { layerLabel }
  );
}

export function windUvRgApiUrl(datehour: string, pressureLevel: number) {
  if (usesPublicDataAssets()) {
    return buildPublicDataUrl(
      "wind-uv-rg",
      String(pressureLevel),
      toHourlyPngFilename(datehour)
    );
  }

  return `/api/wind_uv/${encodeURIComponent(String(pressureLevel))}/${encodeURIComponent(datehour)}`;
}

export function potentialVorticityApiUrl(datehour: string, pressureLevel: number) {
  if (usesPublicDataAssets()) {
    return buildPublicDataUrl(
      "potential-vorticity-rg",
      String(pressureLevel),
      toHourlyPngFilename(datehour)
    );
  }

  return `/api/potential_vorticity/${encodeURIComponent(String(pressureLevel))}/${encodeURIComponent(datehour)}`;
}

export function divergenceApiUrl(datehour: string, pressureLevel: number) {
  if (usesPublicDataAssets()) {
    return buildPublicDataUrl(
      "divergence-rg",
      String(pressureLevel),
      toHourlyPngFilename(datehour)
    );
  }

  return `/api/divergence/${encodeURIComponent(String(pressureLevel))}/${encodeURIComponent(datehour)}`;
}

export function verticalVelocityApiUrl(datehour: string, pressureLevel: number) {
  if (usesPublicDataAssets()) {
    return buildPublicDataUrl(
      "vertical-velocity-rg",
      String(pressureLevel),
      toHourlyPngFilename(datehour)
    );
  }

  return `/api/vertical_velocity/${encodeURIComponent(String(pressureLevel))}/${encodeURIComponent(datehour)}`;
}

export function temperatureApiUrl(datehour: string, pressureLevel: number) {
  if (usesPublicDataAssets()) {
    return buildPublicDataUrl(
      "temperature-rg",
      String(pressureLevel),
      toHourlyPngFilename(datehour)
    );
  }

  return `/api/temperature/${encodeURIComponent(String(pressureLevel))}/${encodeURIComponent(datehour)}`;
}

export function backwardTrajectoryApiUrl() {
  if (usesPublicDataAssets()) {
    return buildPublicDataUrl("backward_trajectory", "current.json");
  }

  return "/api/backward_trajectory";
}

export function trajectorySteeringApiUrl() {
  if (usesPublicDataAssets()) {
    return buildPublicDataUrl("trajectory_steering", "current.json");
  }

  return "/api/trajectory_steering";
}

export function upperAirSupportApiUrl() {
  if (usesPublicDataAssets()) {
    return buildPublicDataUrl("upper_air_support", "current.json");
  }

  return "/api/upper_air_support";
}

function normalizeUpperAirSupportHourKey(hourKey: string) {
  const trimmed = hourKey.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(trimmed);
  if (match) return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:00`;

  const dt = new Date(trimmed);
  if (Number.isFinite(dt.getTime())) {
    const y = dt.getUTCFullYear();
    const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    const h = String(dt.getUTCHours()).padStart(2, "0");
    return `${y}-${mo}-${d}T${h}:00`;
  }

  return trimmed;
}

export function upperAirSupportFrameApiUrl(hourKey: string) {
  if (usesPublicDataAssets()) {
    return buildPublicDataUrl(
      "upper_air_support",
      "frames",
      `${normalizeUpperAirSupportHourKey(hourKey).replace(":", "-")}.json`
    );
  }

  return `/api/upper_air_support/${encodeURIComponent(
    normalizeUpperAirSupportHourKey(hourKey)
  )}`;
}

export type BackwardTrajectoryContourSnippet = {
  level_m: number;
  gph_m: number;
  segment_index: number;
  piece_index?: number;
  min_distance_deg: number;
  points: LonLat[];
};

export type BackwardTrajectoryExtremaContour = {
  branch: "decreasing" | "increasing";
  level_m: number;
  gph_m: number;
  segment_index: number;
  min_distance_deg: number;
  is_closed: boolean;
  points: LonLat[];
};

export type BackwardTrajectoryFinalExtremaContours = {
  status: "ok" | "partial" | "none";
  message: string;
  lower_branch: "decreasing" | "increasing" | null;
  higher_branch: "decreasing" | "increasing" | null;
  lower_gph_m: number | null;
  higher_gph_m: number | null;
  decreasing_contour: BackwardTrajectoryExtremaContour | null;
  increasing_contour: BackwardTrajectoryExtremaContour | null;
  lower_contour: BackwardTrajectoryExtremaContour | null;
  higher_contour: BackwardTrajectoryExtremaContour | null;
};

export type BackwardTrajectoryGhostForwardCell = {
  forward_hour: number;
  latitude: number;
  longitude: number;
  longitude_360: number;
};

export type BackwardTrajectoryPoint = {
  step_hour: number;
  valid_time: string;
  latitude: number;
  longitude: number;
  longitude_360: number;
  tcw_kg_m2: number;
  precip_mm: number;
  evap_mm_added: number;
  gph_m: number;
  contours: BackwardTrajectoryContourSnippet[];
  final_extrema_contours: BackwardTrajectoryFinalExtremaContours;
  ghost_forward_advected_cells?: BackwardTrajectoryGhostForwardCell[];
  ghost_forward_advected_cells_timevarying?: BackwardTrajectoryGhostForwardCell[];
};

export type BackwardTrajectoryFile = {
  metadata: {
    target_name: string;
    start_lat: number;
    start_lon: number;
    start_lon_360: number;
    requested_start_time: string;
    resolved_start_time: string;
    pressure_level_hpa: number;
    hours_back_requested: number;
    hours_back_actual: number;
    substeps: number;
    contour_levels_m: number[];
    max_contour_distance_deg: number;
    ghost_forward_hours?: number;
    ghost_substeps_per_hour?: number;
    ghost_advection_method?: string;
    ghost_advection_method_timevarying?: string;
    final_extrema_contour_scale_m: {
      min: number;
      mid: number;
      max: number;
    };
    generated_at_utc: string;
  };
  summary: {
    point_count: number;
    tcw_min_kg_m2: number;
    tcw_max_kg_m2: number;
    gph_min_m: number;
    gph_max_m: number;
    precip_total_mm: number;
    evap_total_mm_added: number;
    extrema_contour_hours_with_any: number;
    extrema_contour_hours_with_both: number;
  };
  points: BackwardTrajectoryPoint[];
  points_by_hour: Record<string, BackwardTrajectoryPoint>;
};

export async function fetchBackwardTrajectory(): Promise<BackwardTrajectoryFile> {
  return fetchJsonOrThrow<BackwardTrajectoryFile>(
    backwardTrajectoryApiUrl(),
    "Failed to load backward trajectory data.",
    { layerLabel: "Backward trajectory" }
  );
}

export type TrajectorySteeringContour = {
  level_m: number;
  segment_index: number;
  points: LonLat[];
};

export type TrajectorySteeringSample = {
  latitude: number;
  longitude: number;
  longitude_360: number;
  gph_m: number;
  gph_grad_m_per_100km: number;
  thetae_k: number;
  thetae_grad_k_per_100km: number;
  wind_speed_ms: number;
};

export type TrajectorySteeringPoint = {
  step_hour: number;
  valid_time: string;
  hour_key: string;
  latitude: number;
  longitude: number;
  longitude_360: number;
  gph_m: number;
  wind_speed_ms: number;
};

export type TrajectorySteeringFrame = TrajectorySteeringPoint & {
  grid_latitudes: number[];
  grid_longitudes: number[];
  samples: TrajectorySteeringSample[];
  contours: TrajectorySteeringContour[];
};

export type TrajectorySteeringFile = {
  metadata: {
    target_name: string;
    start_lat: number;
    start_lon: number;
    start_lon_360: number;
    requested_start_time: string;
    resolved_start_time: string;
    pressure_level_hpa: number;
    hours_back_requested: number;
    hours_back_actual: number;
    substeps: number;
    hue_field: string;
    saturation_field: string;
    opacity_field: string;
    contour_levels_m: number[];
    sample_half_span_lat_deg: number;
    sample_half_span_lon_deg: number;
    sample_spacing_deg: number;
    contour_half_span_lat_deg: number;
    contour_half_span_lon_deg: number;
    contour_spacing_deg: number;
    generated_at_utc: string;
  };
  summary: {
    point_count: number;
    frame_count: number;
    gph_min_m: number;
    gph_max_m: number;
    thetae_min_k: number;
    thetae_max_k: number;
    thetae_mid_k: number;
    thetae_p10_k: number;
    thetae_p90_k: number;
    thetae_center_k: number;
    thetae_half_range_k: number;
    thetae_grad_p95_k_per_100km: number;
    gph_grad_p50_m_per_100km: number;
    gph_grad_p90_m_per_100km: number;
    gph_grad_p95_m_per_100km: number;
    wind_speed_min_ms: number;
    wind_speed_p25_ms: number;
    wind_speed_p95_ms: number;
  };
  points: TrajectorySteeringPoint[];
  frames: TrajectorySteeringFrame[];
  frames_by_hour: Record<string, TrajectorySteeringFrame>;
};

export async function fetchTrajectorySteering(): Promise<TrajectorySteeringFile> {
  return fetchJsonOrThrow<TrajectorySteeringFile>(
    trajectorySteeringApiUrl(),
    "Failed to load trajectory steering data.",
    { layerLabel: "Trajectory steering" }
  );
}

export type UpperAirSupportPoint = {
  step_hour: number;
  valid_time: string;
  hour_key: string;
  latitude: number;
  longitude: number;
};

export type UpperAirSupportFeaturePoint = {
  latitude: number;
  longitude: number;
  value: number;
};

export type UpperAirSupportCell = [
  pv250_excess_pvu: number,
  trough250_depth_m: number,
  low925_depth_m: number,
  ascent500_pa_s: number,
  divergence250_s1: number,
  convergence925_s1: number,
  thickness_deficit_m: number,
  u250_ms: number,
  v250_ms: number,
  jet250_ms: number,
  moisture_flux_u: number,
  moisture_flux_v: number,
  moisture_flux_mag: number,
] | null;

export type UpperAirSupportFrameFeatures = {
  pv250_peak: UpperAirSupportFeaturePoint | null;
  trough250_min: UpperAirSupportFeaturePoint | null;
  low925_min: UpperAirSupportFeaturePoint | null;
  divergence250_peak: UpperAirSupportFeaturePoint | null;
  ascent500_peak: UpperAirSupportFeaturePoint | null;
  convergence925_peak: UpperAirSupportFeaturePoint | null;
  thickness_deficit_peak: UpperAirSupportFeaturePoint | null;
  jet250_peak: UpperAirSupportFeaturePoint | null;
  moisture_flux_peak: UpperAirSupportFeaturePoint | null;
};

export type UpperAirSupportFrame = {
  step_hour: number;
  valid_time: string;
  hour_key: string;
  latitude: number;
  longitude: number;
  grid_latitudes: number[];
  grid_longitudes: number[];
  cells: UpperAirSupportCell[];
  features: UpperAirSupportFrameFeatures;
};

export type UpperAirSupportManifest = {
  metadata: {
    target_name: string;
    start_lat: number;
    start_lon: number;
    start_lon_360: number;
    requested_start_time: string;
    resolved_start_time: string;
    trajectory_pressure_level_hpa: number;
    pv_level_hpa: number;
    upper_trough_level_hpa: number;
    lower_low_level_hpa: number;
    vertical_velocity_level_hpa: number;
    upper_divergence_level_hpa: number;
    lower_convergence_level_hpa: number;
    upper_wind_level_hpa: number;
    moisture_flux_level_hpa: number;
    thickness_upper_level_hpa: number;
    thickness_lower_level_hpa: number;
    hours_back_requested: number;
    hours_back_actual: number;
    substeps: number;
    field_half_span_lat_deg: number;
    field_half_span_lon_deg: number;
    sample_spacing_deg: number;
    box_size: number;
    source_grid_spacing_deg: number;
    generated_at_utc: string;
  };
  summary: {
    point_count: number;
    frame_count: number;
    sample_count_per_frame: number;
    pv_p75_pvu: number;
    pv_p90_pvu: number;
    pv_p95_pvu: number;
    pv_max_pvu: number;
    trough_depth_p75_m: number;
    trough_depth_p90_m: number;
    trough_depth_p95_m: number;
    trough_depth_max_m: number;
    low925_depth_p75_m: number;
    low925_depth_p90_m: number;
    low925_depth_p95_m: number;
    low925_depth_max_m: number;
    ascent_p75_pa_s: number;
    ascent_p90_pa_s: number;
    ascent_p95_pa_s: number;
    ascent_max_pa_s: number;
    divergence250_p75_s1: number;
    divergence250_p90_s1: number;
    divergence250_p95_s1: number;
    divergence250_max_s1: number;
    convergence925_p75_s1: number;
    convergence925_p90_s1: number;
    convergence925_p95_s1: number;
    convergence925_max_s1: number;
    thickness_deficit_p75_m: number;
    thickness_deficit_p90_m: number;
    thickness_deficit_p95_m: number;
    thickness_deficit_max_m: number;
    jet250_p75_ms: number;
    jet250_p90_ms: number;
    jet250_p95_ms: number;
    jet250_max_ms: number;
    moisture_flux_p75: number;
    moisture_flux_p90: number;
    moisture_flux_p95: number;
    moisture_flux_max: number;
  };
  points: UpperAirSupportPoint[];
};

export async function fetchUpperAirSupportManifest(): Promise<UpperAirSupportManifest> {
  return fetchJsonOrThrow<UpperAirSupportManifest>(
    upperAirSupportApiUrl(),
    "Failed to load upper-air support data.",
    { layerLabel: "Upper-air support" }
  );
}

export async function fetchUpperAirSupportFrame(
  hourKey: string
): Promise<UpperAirSupportFrame> {
  const normalizedHourKey = normalizeUpperAirSupportHourKey(hourKey);
  return fetchJsonOrThrow<UpperAirSupportFrame>(
    upperAirSupportFrameApiUrl(normalizedHourKey),
    "Failed to load upper-air support frame.",
    { layerLabel: "Upper-air support" }
  );
}
