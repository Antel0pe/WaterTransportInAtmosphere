export function moistureTransportApiUrl(datehour: string) {
  return `/api/moisture_transport/${encodeURIComponent(datehour)}`;
}