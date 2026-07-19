import { memo, useMemo } from "react";
import * as THREE from "three";
import type { ScenePoint3 } from "./scene-math";

const UP = new THREE.Vector3(0, 1, 0);

export const StructuralBeam = memo(function StructuralBeam({
  from,
  to,
  width = 0.42,
  color = "#56616a",
  metalness = 0.82,
  roughness = 0.34,
  castShadow = true
}: {
  from: ScenePoint3;
  to: ScenePoint3;
  width?: number;
  color?: string;
  metalness?: number;
  roughness?: number;
  castShadow?: boolean;
}) {
  const transform = useMemo(() => {
    const start = new THREE.Vector3(...from);
    const end = new THREE.Vector3(...to);
    const direction = end.clone().sub(start);
    const length = direction.length();
    const midpoint = start.clone().add(end).multiplyScalar(0.5);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, direction.normalize());
    return { length, midpoint, quaternion };
  }, [from, to]);

  return (
    <mesh position={transform.midpoint} quaternion={transform.quaternion} castShadow={castShadow} receiveShadow>
      <boxGeometry args={[width, transform.length, width]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.09}
        metalness={metalness}
        roughness={roughness}
      />
    </mesh>
  );
});

export const WarningStripe = memo(function WarningStripe({
  position,
  rotation = [0, 0, 0],
  size
}: {
  position: ScenePoint3;
  rotation?: ScenePoint3;
  size: ScenePoint3;
}) {
  return (
    <mesh position={position} rotation={rotation} receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color="#d7a329" metalness={0.48} roughness={0.5} />
    </mesh>
  );
});
