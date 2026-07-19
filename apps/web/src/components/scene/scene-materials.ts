import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { seededVisualNoise } from "./scene-math";

export interface SeededSurfaceTextures {
  roughness: THREE.DataTexture;
  normal: THREE.DataTexture;
}

const sample = (seed: number, x: number, y: number, size: number): number =>
  seededVisualNoise(seed, y * size + x);

export function createSeededSurfaceTextures(seed: number, size = 96): SeededSurfaceTextures {
  const roughnessBytes = new Uint8Array(size * size * 4);
  const normalBytes = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const value = sample(seed, x, y, size);
      const right = sample(seed, (x + 1) % size, y, size);
      const down = sample(seed, x, (y + 1) % size, size);
      const roughness = Math.round((0.54 + value * 0.42) * 255);
      roughnessBytes.set([roughness, roughness, roughness, 255], offset);
      const nx = Math.round(128 + (value - right) * 64);
      const ny = Math.round(128 + (value - down) * 64);
      normalBytes.set([nx, ny, 245, 255], offset);
    }
  }

  const roughness = new THREE.DataTexture(roughnessBytes, size, size, THREE.RGBAFormat);
  const normal = new THREE.DataTexture(normalBytes, size, size, THREE.RGBAFormat);
  for (const texture of [roughness, normal]) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
  }
  roughness.repeat.set(8, 8);
  normal.repeat.set(10, 10);
  return { roughness, normal };
}

export function useSeededSurfaceTextures(seed: number): SeededSurfaceTextures {
  const textures = useMemo(() => createSeededSurfaceTextures(seed), [seed]);
  useEffect(() => () => {
    textures.roughness.dispose();
    textures.normal.dispose();
  }, [textures]);
  return textures;
}
