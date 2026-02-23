export function evaporationApiUrl(datehour: string) {
  return `/api/evaporation/${encodeURIComponent(datehour)}`;
}

export function totalColumnWaterApiUrl(datehour: string) {
  return `/api/total_column_water/${encodeURIComponent(datehour)}`;
}

export function ivtApiUrl(datehour: string) {
  return `/api/ivt/${encodeURIComponent(datehour)}`;
}

export function mslContoursApiUrl(datehour: string) {
  return `/api/msl_contours/${encodeURIComponent(datehour)}`;
}

export type LonLat = [number, number];
export type ContourLine = LonLat[];
export type ContourLevels = Record<string, ContourLine[]>;

export type MslContoursFile = {
  timestamp: string; // "2021-12-13T00:00:00"
  contour_step_hpa: number;
  levels: ContourLevels; // keys like "960.0"
};

export async function fetchMslContours(datehour: string): Promise<MslContoursFile> {
  const res = await fetch(mslContoursApiUrl(datehour));

  if (!res.ok) {
    throw new Error(`MSL contours fetch failed (${res.status} ${res.statusText})`);
  }

  return (await res.json()) as MslContoursFile;
}

export function windUv925RgApiUrl(datehour: string) {
  return `/api/wind_uv/${encodeURIComponent(datehour)}`;
}