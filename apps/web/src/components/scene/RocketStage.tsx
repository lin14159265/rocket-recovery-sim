import { memo, useEffect, useMemo } from "react";
import { useTexture } from "@react-three/drei";
import type { ScenarioConfig } from "@recovery/sim-core";
import * as THREE from "three";
import weatheringMaskUrl from "../../assets/recovery-scene/rocket-weathering-mask.webp";

useTexture.preload(weatheringMaskUrl);

const EngineBell = memo(function EngineBell({ x, z, radius }: { x: number; z: number; radius: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh castShadow>
        <cylinderGeometry args={[radius * 0.36, radius * 0.7, radius * 1.4, 20, 1, true]} />
        <meshPhysicalMaterial
          color="#333a3e"
          metalness={0.9}
          roughness={0.32}
          clearcoat={0.18}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh position={[0, -radius * 0.72, 0]}>
        <torusGeometry args={[radius * 0.69, radius * 0.08, 8, 20]} />
        <meshStandardMaterial color="#b2a18a" metalness={0.42} roughness={0.63} />
      </mesh>
    </group>
  );
});

export const RocketStage = memo(function RocketStage({ config }: { config: ScenarioConfig }) {
  const bodyLength = config.rocket.lengthM;
  const radius = config.rocket.radiusM;
  const attachmentBandOffsetM = bodyLength * 0.3;
  const sourceMask = useTexture(weatheringMaskUrl);
  const sootMask = useMemo(() => {
    const texture = sourceMask.clone();
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(0.25, 0.25);
    texture.offset.set(0.25, 0.5);
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
  }, [sourceMask]);

  useEffect(() => () => sootMask.dispose(), [sootMask]);

  const panelRings = useMemo(
    () => Array.from({ length: 8 }, (_, index) => -bodyLength * 0.42 + index * bodyLength * 0.12),
    [bodyLength]
  );
  const enginePositions = useMemo(() => {
    const ring = radius * 0.43;
    return [
      [0, 0],
      [ring, 0],
      [-ring, 0],
      [0, ring],
      [0, -ring]
    ] as const;
  }, [radius]);

  return (
    <group>
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[radius, radius * 0.97, bodyLength, 48, 8]} />
        <meshPhysicalMaterial
          color="#d8dde0"
          metalness={0.58}
          roughness={0.4}
          clearcoat={0.22}
          clearcoatRoughness={0.46}
        />
      </mesh>

      <mesh castShadow scale={[1.006, 1, 1.006]}>
        <cylinderGeometry args={[radius, radius * 0.97, bodyLength * 0.53, 48, 1, true]} />
        <meshStandardMaterial
          color="#202427"
          alphaMap={sootMask}
          transparent
          opacity={0.74}
          depthWrite={false}
          roughness={0.75}
          metalness={0.12}
          side={THREE.DoubleSide}
        />
      </mesh>

      <mesh position={[0, bodyLength / 2 + radius * 0.74, 0]} castShadow receiveShadow>
        <coneGeometry args={[radius, radius * 1.55, 48, 5]} />
        <meshPhysicalMaterial color="#e2e5e5" metalness={0.52} roughness={0.38} clearcoat={0.18} />
      </mesh>
      <mesh position={[0, bodyLength / 2 + radius * 1.3, 0]} castShadow>
        <coneGeometry args={[radius * 0.19, radius * 0.78, 28]} />
        <meshStandardMaterial color="#c9ced0" metalness={0.68} roughness={0.35} />
      </mesh>

      {panelRings.map((height, index) => (
        <mesh key={height} position={[0, height, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow={index % 2 === 0}>
          <torusGeometry args={[radius * 1.006, 0.035, 6, 48]} />
          <meshStandardMaterial color="#747d82" metalness={0.8} roughness={0.36} />
        </mesh>
      ))}

      {Array.from({ length: 6 }, (_, index) => {
        const angle = (index / 6) * Math.PI * 2;
        return (
          <mesh
            key={angle}
            position={[Math.cos(angle) * radius * 1.007, 0, Math.sin(angle) * radius * 1.007]}
            rotation={[0, -angle, 0]}
          >
            <boxGeometry args={[0.025, bodyLength * 0.94, 0.045]} />
            <meshStandardMaterial color="#8f979a" metalness={0.68} roughness={0.42} />
          </mesh>
        );
      })}

      <group position={[0, attachmentBandOffsetM, 0]}>
        <mesh castShadow>
          <cylinderGeometry args={[radius * 1.025, radius * 1.025, 0.64, 48]} />
          <meshPhysicalMaterial color="#30393f" metalness={0.9} roughness={0.24} clearcoat={0.3} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[radius * 1.08, 0.13, 10, 64]} />
          <meshStandardMaterial color="#758088" metalness={0.92} roughness={0.23} />
        </mesh>
        {Array.from({ length: 12 }, (_, index) => {
          const angle = (index / 12) * Math.PI * 2;
          return (
            <mesh key={angle} position={[Math.cos(angle) * radius * 1.09, 0, Math.sin(angle) * radius * 1.09]}>
              <sphereGeometry args={[0.075, 8, 8]} />
              <meshStandardMaterial color="#a6afb4" metalness={0.9} roughness={0.22} />
            </mesh>
          );
        })}
      </group>

      <group position={[0, -bodyLength / 2 - radius * 0.5, 0]}>
        <mesh position={[0, radius * 0.45, 0]} castShadow>
          <cylinderGeometry args={[radius * 0.93, radius * 0.8, radius * 0.95, 36]} />
          <meshStandardMaterial color="#444b4f" metalness={0.86} roughness={0.34} />
        </mesh>
        {enginePositions.map(([x, z]) => (
          <EngineBell key={`${x}-${z}`} x={x} z={z} radius={radius * 0.34} />
        ))}
      </group>
    </group>
  );
});
