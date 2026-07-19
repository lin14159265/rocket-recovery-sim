import { memo, useMemo } from "react";
import type { ScenarioConfig } from "@recovery/sim-core";
import { StructuralBeam, WarningStripe } from "./ScenePrimitives";
import type { ScenePoint3 } from "./scene-math";
import type { SeededSurfaceTextures } from "./scene-materials";

const WinchAssembly = memo(function WinchAssembly({
  position,
  rotationY = 0
}: {
  position: ScenePoint3;
  rotationY?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
        <boxGeometry args={[3.5, 1.1, 2.35]} />
        <meshStandardMaterial color="#26313a" metalness={0.82} roughness={0.38} />
      </mesh>
      <mesh position={[0, 1.55, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.76, 0.76, 2.2, 24]} />
        <meshStandardMaterial color="#66727a" metalness={0.9} roughness={0.3} />
      </mesh>
      <mesh position={[0, 1.55, 0]} rotation={[0, 0, Math.PI / 2]}>
        <torusGeometry args={[0.78, 0.12, 8, 24]} />
        <meshStandardMaterial color="#313a41" metalness={0.9} roughness={0.28} />
      </mesh>
      {[-1.15, 1.15].map((x) => (
        <mesh key={x} position={[x, 1.55, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.96, 0.96, 0.16, 24]} />
          <meshStandardMaterial color="#434f57" metalness={0.88} roughness={0.33} />
        </mesh>
      ))}
      <mesh position={[0, 1.52, 2.05]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.42, 0.42, 0.5, 20]} />
        <meshStandardMaterial color="#879197" metalness={0.92} roughness={0.25} />
      </mesh>
    </group>
  );
});

const GuardRail = memo(function GuardRail({ from, to }: { from: ScenePoint3; to: ScenePoint3 }) {
  const height = 1.2;
  return (
    <group>
      <StructuralBeam from={[from[0], from[1], from[2]]} to={[from[0], from[1] + height, from[2]]} width={0.07} color="#a8b1b5" />
      <StructuralBeam from={[to[0], to[1], to[2]]} to={[to[0], to[1] + height, to[2]]} width={0.07} color="#a8b1b5" />
      <StructuralBeam from={[from[0], from[1] + height, from[2]]} to={[to[0], to[1] + height, to[2]]} width={0.07} color="#a8b1b5" />
      <StructuralBeam from={[from[0], from[1] + height * 0.53, from[2]]} to={[to[0], to[1] + height * 0.53, to[2]]} width={0.05} color="#7f8b91" />
    </group>
  );
});

export const RecoveryVessel = memo(function RecoveryVessel({
  config,
  surfaceTextures
}: {
  config: ScenarioConfig;
  surfaceTextures: SeededSurfaceTextures;
}) {
  const width = config.platform.frameHalfWidthM;
  const depth = config.platform.frameHalfDepthM;
  const height = config.platform.frameHeightM;
  const captureY = config.platform.capturePlaneZ;
  const hullWidth = width * 3.05;
  const hullDepth = depth * 3.25;
  const wellHalf = Math.max(config.rocket.radiusM * 3.2, config.net.closedHalfSpacingM * 2.1);
  const deckY = -0.15;
  const corners: ScenePoint3[] = [
    [-width, 0, -depth],
    [width, 0, -depth],
    [width, 0, depth],
    [-width, 0, depth]
  ];
  const top: ScenePoint3[] = corners.map(([x, , z]) => [x, height, z]);
  const capture: ScenePoint3[] = corners.map(([x, , z]) => [x, captureY, z]);
  const deckSlabs = useMemo(() => [
    { position: [-(wellHalf + hullWidth / 2) / 2, deckY, 0] as ScenePoint3, size: [(hullWidth / 2 - wellHalf), 0.32, hullDepth] as ScenePoint3 },
    { position: [(wellHalf + hullWidth / 2) / 2, deckY, 0] as ScenePoint3, size: [(hullWidth / 2 - wellHalf), 0.32, hullDepth] as ScenePoint3 },
    { position: [0, deckY, -(wellHalf + hullDepth / 2) / 2] as ScenePoint3, size: [wellHalf * 2, 0.32, hullDepth / 2 - wellHalf] as ScenePoint3 },
    { position: [0, deckY, (wellHalf + hullDepth / 2) / 2] as ScenePoint3, size: [wellHalf * 2, 0.32, hullDepth / 2 - wellHalf] as ScenePoint3 }
  ], [deckY, hullDepth, hullWidth, wellHalf]);

  return (
    <group>
      <mesh position={[0, -2.3, 0]} castShadow receiveShadow>
        <boxGeometry args={[hullWidth, 4.2, hullDepth]} />
        <meshPhysicalMaterial color="#18242d" metalness={0.7} roughness={0.38} clearcoat={0.32} />
      </mesh>
      <mesh position={[0, -4.7, 0]} castShadow>
        <boxGeometry args={[hullWidth * 0.92, 1.2, hullDepth * 0.94]} />
        <meshStandardMaterial color="#0c151c" metalness={0.64} roughness={0.58} />
      </mesh>

      {deckSlabs.map((slab, index) => (
        <mesh key={index} position={slab.position} receiveShadow castShadow>
          <boxGeometry args={slab.size} />
          <meshPhysicalMaterial
            color="#29343b"
            metalness={0.4}
            roughness={0.58}
            roughnessMap={surfaceTextures.roughness}
            aoMap={surfaceTextures.roughness}
            aoMapIntensity={0.32}
            normalMap={surfaceTextures.normal}
            normalScale={[0.28, 0.28]}
            clearcoat={0.14}
            clearcoatRoughness={0.54}
          />
        </mesh>
      ))}

      <mesh position={[0, -1.2, 0]} receiveShadow>
        <boxGeometry args={[wellHalf * 2.04, 2.25, wellHalf * 2.04]} />
        <meshStandardMaterial color="#070c11" metalness={0.3} roughness={0.76} />
      </mesh>
      {[-1, 1].flatMap((signX) => [-1, 1].map((signZ) => (
        <WarningStripe
          key={`${signX}-${signZ}`}
          position={[signX * (wellHalf + 0.35), 0.05, signZ * wellHalf * 0.62]}
          size={[0.5, 0.06, wellHalf * 0.72]}
        />
      )))}

      {corners.map((corner, index) => (
        <StructuralBeam key={`post-${index}`} from={corner} to={top[index] ?? corner} width={0.72} color="#56616a" />
      ))}
      {[top, capture].flatMap((level, levelIndex) => level.map((point, index) => (
        <StructuralBeam
          key={`rail-${levelIndex}-${index}`}
          from={point}
          to={level[(index + 1) % level.length] ?? point}
          width={levelIndex === 0 ? 0.68 : 0.46}
          color={levelIndex === 0 ? "#657078" : "#4c5961"}
        />
      )))}

      {corners.flatMap((corner, index) => {
        const next = corners[(index + 1) % corners.length] ?? corner;
        const topNext = top[(index + 1) % top.length] ?? top[index] ?? corner;
        return [
          <StructuralBeam key={`brace-a-${index}`} from={corner} to={topNext} width={0.34} color="#46525a" />,
          <StructuralBeam key={`brace-b-${index}`} from={next} to={top[index] ?? corner} width={0.34} color="#46525a" />
        ];
      })}

      <WinchAssembly position={[-width * 1.05, 0.15, -depth * 0.58]} rotationY={Math.PI / 2} />
      <WinchAssembly position={[width * 1.05, 0.15, depth * 0.58]} rotationY={-Math.PI / 2} />
      <WinchAssembly position={[-width * 0.58, 0.15, depth * 1.04]} />
      <WinchAssembly position={[width * 0.58, 0.15, -depth * 1.04]} rotationY={Math.PI} />

      <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[config.rocket.radiusM * 1.48, config.rocket.radiusM * 1.72, 64]} />
        <meshStandardMaterial color="#d4a733" emissive="#8b5b10" emissiveIntensity={0.18} metalness={0.45} roughness={0.48} />
      </mesh>

      <GuardRail from={[-hullWidth / 2 + 2, 0, -hullDepth / 2 + 1]} to={[hullWidth / 2 - 2, 0, -hullDepth / 2 + 1]} />
      <GuardRail from={[-hullWidth / 2 + 2, 0, hullDepth / 2 - 1]} to={[hullWidth / 2 - 2, 0, hullDepth / 2 - 1]} />

      {[-1, 1].map((sign) => (
        <group key={sign} position={[sign * (width + 3.5), 2.1, depth * 0.15]}>
          <mesh castShadow>
            <boxGeometry args={[2.7, 4.2, 3.4]} />
            <meshStandardMaterial color="#465159" metalness={0.68} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.6, sign * 1.72]}>
            <boxGeometry args={[1.7, 0.85, 0.05]} />
            <meshStandardMaterial color="#587f89" emissive="#264d56" emissiveIntensity={0.12} metalness={0.38} roughness={0.3} />
          </mesh>
        </group>
      ))}
    </group>
  );
});
