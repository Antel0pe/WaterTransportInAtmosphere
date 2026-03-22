export function evaporationApiUrl(datehour: string) {
  return `/api/evaporation/${encodeURIComponent(datehour)}`;
}

export function totalColumnWaterApiUrl(datehour: string) {
  return `/api/total_column_water/${encodeURIComponent(datehour)}`;
}

export function ivtApiUrl(datehour: string) {
  return `/api/ivt/${encodeURIComponent(datehour)}`;
}

export type ContoursPressure = "msl" | "250" | "500" | "925";

export function mslContoursApiUrl(datehour: string, pressure: ContoursPressure) {
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
  const res = await fetch(mslContoursApiUrl(datehour, pressure));

  if (!res.ok) {
    throw new Error(`MSL contours fetch failed (${res.status} ${res.statusText})`);
  }

  return (await res.json()) as MslContoursFile;
}

export function windUvRgApiUrl(datehour: string, pressureLevel: number) {
  return `/api/wind_uv/${encodeURIComponent(String(pressureLevel))}/${encodeURIComponent(datehour)}`;
}

export function potentialVorticityApiUrl(datehour: string, pressureLevel: number) {
  return `/api/potential_vorticity/${encodeURIComponent(String(pressureLevel))}/${encodeURIComponent(datehour)}`;
}

export function divergenceApiUrl(datehour: string, pressureLevel: number) {
  return `/api/divergence/${encodeURIComponent(String(pressureLevel))}/${encodeURIComponent(datehour)}`;
}

export function verticalVelocityApiUrl(datehour: string, pressureLevel: number) {
  return `/api/vertical_velocity/${encodeURIComponent(String(pressureLevel))}/${encodeURIComponent(datehour)}`;
}

export function temperatureApiUrl(datehour: string, pressureLevel: number) {
  return `/api/temperature/${encodeURIComponent(String(pressureLevel))}/${encodeURIComponent(datehour)}`;
}

export function backwardTrajectoryApiUrl() {
  return "/api/backward_trajectory";
}

export function trajectorySteeringApiUrl() {
  return "/api/trajectory_steering";
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
  const res = await fetch(backwardTrajectoryApiUrl());

  if (!res.ok) {
    throw new Error(
      `Backward trajectory fetch failed (${res.status} ${res.statusText})`
    );
  }

  return (await res.json()) as BackwardTrajectoryFile;
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
  const res = await fetch(trajectorySteeringApiUrl());

  if (!res.ok) {
    throw new Error(
      `Trajectory steering fetch failed (${res.status} ${res.statusText})`
    );
  }

  return (await res.json()) as TrajectorySteeringFile;
}
