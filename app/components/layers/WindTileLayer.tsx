"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useEarthLayer, type EarthViewTile } from "./EarthBase";
import { getGlobeRadius, latLonToVec3 } from "../utils/EarthUtils";
import { windUvTitilerTileApiUrl } from "../utils/ApiResponses";
import { useControls } from "@/app/state/controlsStore";

function buildTilePatchGeometry(
  tile: EarthViewTile,
  radius: number,
  lonOffsetDeg = 270
) {
  const west = tile.west;
  const east = tile.east;
  const north = tile.north;
  const south = tile.south;

  const lonSpan = Math.abs(east - west);
  const latSpan = Math.abs(north - south);
  const lonSegments = Math.max(8, Math.ceil(lonSpan * 2));
  const latSegments = Math.max(8, Math.ceil(latSpan * 2));

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let j = 0; j <= latSegments; j++) {
    const v = j / latSegments;
    const lat = north + (south - north) * v;

    for (let i = 0; i <= lonSegments; i++) {
      const u = i / lonSegments;
      const lon = west + (east - west) * u;
      const p = latLonToVec3(lat, lon, radius, lonOffsetDeg, 0);

      positions.push(p.x, p.y, p.z);
      const n = p.clone().normalize();
      normals.push(n.x, n.y, n.z);
      uvs.push(u, v);
    }
  }

  const stride = lonSegments + 1;
  for (let j = 0; j < latSegments; j++) {
    for (let i = 0; i < lonSegments; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setIndex(indices);
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return geom;
}

export default function WindTileLayer() {
  const windTilePressure = useControls((s) => s.windTilePressure);
  const layerKey = useMemo(() => `wind-tile-${windTilePressure}`, [windTilePressure]);
  const { engineReady, sceneRef, globeRef, timestamp, viewState, signalReady } =
    useEarthLayer(layerKey);

  const meshRef = useRef<THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null>(
    null
  );
  const texRef = useRef<THREE.Texture | null>(null);

  useEffect(() => {
    if (!engineReady) return;
    if (!sceneRef.current) return;

    const scene = sceneRef.current;
    const geom = new THREE.BufferGeometry();
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uTex: { value: null as THREE.Texture | null },
        uOpacity: { value: 1.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uTex;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          vec4 texel = texture2D(uTex, vUv);
          if (texel.a <= 0.01) discard;
          gl_FragColor = vec4(texel.rgb, texel.a * uOpacity);
        }
      `,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = "wind-tile-layer";
    mesh.renderOrder = 56;
    mesh.frustumCulled = false;
    scene.add(mesh);
    meshRef.current = mesh;

    return () => {
      meshRef.current = null;
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
      if (texRef.current) {
        texRef.current.dispose();
        texRef.current = null;
      }
    };
  }, [engineReady, sceneRef]);

  useEffect(() => {
    if (!engineReady) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    if (windTilePressure === "none" || !viewState) {
      mesh.visible = false;
      signalReady(timestamp);
      return;
    }

    let cancelled = false;
    const tile = viewState.tile;
    const globeRadius = globeRef.current ? getGlobeRadius(globeRef.current) : 100;
    const radius = globeRadius * 1.003;

    const nextGeom = buildTilePatchGeometry(tile, radius);
    mesh.geometry.dispose();
    mesh.geometry = nextGeom;
    mesh.visible = true;

    const url = windUvTitilerTileApiUrl(
      timestamp,
      windTilePressure,
      tile.z,
      tile.x,
      tile.y
    );

    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (cancelled) {
          tex.dispose();
          return;
        }

        tex.colorSpace = THREE.NoColorSpace;
        tex.flipY = false;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;

        const prev = texRef.current;
        texRef.current = tex;
        mesh.material.uniforms.uTex.value = tex;
        mesh.material.needsUpdate = true;

        if (prev) prev.dispose();
        signalReady(timestamp);
      },
      undefined,
      (err) => {
        console.error("Failed to load wind tile", err);
        signalReady(timestamp);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [engineReady, globeRef, signalReady, timestamp, viewState, windTilePressure]);

  return null;
}
