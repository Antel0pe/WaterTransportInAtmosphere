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
