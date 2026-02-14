export function moistureTransportApiUrl(datehour: string) {
  return `/api/moisture_transport/${encodeURIComponent(datehour)}`;
}

export function totalColumnWaterApiUrl(datehour: string) {
  return `/api/total_column_water/${encodeURIComponent(datehour)}`;
}
