import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// 1) lat/lon -> world position on your globe (origin-centered)
export function latLonToVec3(latDeg: number, lonDeg: number, radius: number, lonOffsetDeg = 270, latOffsetDeg = 0) {
    const lat = THREE.MathUtils.degToRad(latDeg + latOffsetDeg);
    const lon = THREE.MathUtils.degToRad(-(lonDeg + lonOffsetDeg)); // inverting for threejs coord system
    const x = radius * Math.cos(lat) * Math.cos(lon);
    const y = radius * Math.sin(lat);
    const z = radius * Math.cos(lat) * Math.sin(lon);
    return new THREE.Vector3(x, y, z);
}

// 2) compute globe radius from the ThreeGlobe mesh
export function getGlobeRadius(globe: THREE.Object3D) {
    const sphere = new THREE.Sphere();
    new THREE.Box3().setFromObject(globe).getBoundingSphere(sphere);
    return sphere.radius;
}

// 3) fly the camera to a given lat/lon
export function lookAtLatLon(
    lat: number,
    lon: number,
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    globe: THREE.Object3D,
    altitude = 0 // extra distance above surface, in world units
) {
    const R = getGlobeRadius(globe);
    const target = latLonToVec3(lat, lon, R);      // point on surface
    const normal = target.clone().normalize();

    // keep roughly the same viewing distance unless you specify altitude
    const keepDist = camera.position.distanceTo(controls.target);
    const dist = altitude > 0 ? altitude : keepDist;

    const newPos = normal.clone().multiplyScalar(R + dist);

    // snap (or tween if you prefer)
    controls.target.copy(target);
    camera.position.copy(newPos);
    camera.lookAt(controls.target);
    controls.update();
}

export type LonLat = { lon: number; lat: number };

export type TileXYZ = {
    z: number;
    x: number;
    y: number;
};

export type TileBounds = {
    west: number;
    south: number;
    east: number;
    north: number;
};

export function clamp(v: number, min: number, max: number) {
    return Math.min(max, Math.max(min, v));
}

export function normalizeLon(lon: number) {
    let x = ((lon + 180) % 360 + 360) % 360 - 180;
    if (x === -180) x = 180;
    return x;
}

export function vec3ToLatLon(
    v: THREE.Vector3,
    lonOffsetDeg = 270,
    latOffsetDeg = 0
): LonLat {
    const r = Math.max(v.length(), 1e-9);
    const latRad = Math.asin(clamp(v.y / r, -1, 1));
    const lonRad = Math.atan2(v.z, v.x);

    const lat = THREE.MathUtils.radToDeg(latRad) - latOffsetDeg;
    const lon = normalizeLon(-THREE.MathUtils.radToDeg(lonRad) - lonOffsetDeg);

    return { lon, lat };
}

const MAX_WEBMERCATOR_LAT = 85.05112878;

export function clampMercatorLat(lat: number) {
    return clamp(lat, -MAX_WEBMERCATOR_LAT, MAX_WEBMERCATOR_LAT);
}

export function lonLatToTileXYZ(lonDeg: number, latDeg: number, z: number): TileXYZ {
    const n = 2 ** z;
    const lon = normalizeLon(lonDeg);
    const lat = clampMercatorLat(latDeg);
    const latRad = THREE.MathUtils.degToRad(lat);

    const xf = ((lon + 180) / 360) * n;
    const yf =
        (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) * 0.5 * n;

    const x = clamp(Math.floor(xf), 0, n - 1);
    const y = clamp(Math.floor(yf), 0, n - 1);
    return { z, x, y };
}

function tileYToLat(y: number, z: number) {
    const n = Math.PI - (2 * Math.PI * y) / (2 ** z);
    return THREE.MathUtils.radToDeg(Math.atan(Math.sinh(n)));
}

export function tileXYZToBounds(x: number, y: number, z: number): TileBounds {
    const n = 2 ** z;
    const west = (x / n) * 360 - 180;
    const east = ((x + 1) / n) * 360 - 180;
    const north = tileYToLat(y, z);
    const south = tileYToLat(y + 1, z);
    return { west, south, east, north };
}
