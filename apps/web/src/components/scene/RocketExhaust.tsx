import { memo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { ScenarioConfig, SimulationSnapshot } from "@recovery/sim-core";
import * as THREE from "three";

export const RocketExhaust = memo(function RocketExhaust({
  frame,
  config,
  reducedMotion
}: {
  frame: SimulationSnapshot;
  config: ScenarioConfig;
  reducedMotion: boolean;
}) {
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const groupRef = useRef<THREE.Group>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const plumeLength = config.rocket.radiusM * 6.4;

  useFrame(() => {
    const group = groupRef.current;
    if (group === null) return;
    const snapshot = frameRef.current;
    const ratio = Math.min(1, Math.max(0, snapshot.rocket.actualThrustN / Math.max(1, config.rocket.thrustMaxN)));
    group.visible = ratio > 0.025;
    if (!group.visible) return;
    const flicker = reducedMotion ? 1 : 0.96 + Math.sin(snapshot.timeS * 41.3 + config.seed * 0.01) * 0.04;
    group.scale.set(0.72 + ratio * 0.46, (0.4 + ratio * 0.78) * flicker, 0.72 + ratio * 0.46);
    if (lightRef.current !== null) lightRef.current.intensity = 4.5 + ratio * 11;
  });

  return (
    <group
      ref={groupRef}
      position={[0, -config.rocket.lengthM / 2 - plumeLength * 0.48, 0]}
      visible={false}
    >
      <mesh>
        <coneGeometry args={[config.rocket.radiusM * 0.8, plumeLength, 32, 1, true]} />
        <meshBasicMaterial
          color="#d6e5e9"
          transparent
          opacity={0.11}
          depthWrite={false}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, plumeLength * 0.19, 0]}>
        <coneGeometry args={[config.rocket.radiusM * 0.42, plumeLength * 0.58, 28, 1, true]} />
        <meshBasicMaterial
          color="#ffc269"
          transparent
          opacity={0.42}
          depthWrite={false}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
      <pointLight ref={lightRef} position={[0, plumeLength * 0.35, 0]} color="#ffb65f" distance={26} decay={2} />
    </group>
  );
});
