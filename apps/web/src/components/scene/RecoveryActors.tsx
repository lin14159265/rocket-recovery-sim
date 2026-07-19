import { memo, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { ScenarioConfig, SimulationSnapshot } from "@recovery/sim-core";
import * as THREE from "three";
import { CaptureCables } from "./CaptureCables";
import { RecoveryVessel } from "./RecoveryVessel";
import { RocketStage } from "./RocketStage";
import { RocketExhaust } from "./RocketExhaust";
import { SceneTelemetryOverlays } from "./SceneTelemetryOverlays";
import { useSeededSurfaceTextures } from "./scene-materials";
import type { QualityProfile } from "./scene-quality";

export const RecoveryActors = memo(function RecoveryActors({
  frame,
  config,
  profile,
  reducedMotion
}: {
  frame: SimulationSnapshot | null;
  config: ScenarioConfig;
  profile: QualityProfile;
  reducedMotion: boolean;
}) {
  const snapshotRef = useRef(frame);
  snapshotRef.current = frame;
  const platformRef = useRef<THREE.Group>(null);
  const rocketRef = useRef<THREE.Group>(null);
  const surfaceTextures = useSeededSurfaceTextures(config.seed);
  const initialRocketPosition = useMemo(() => [
    config.rocket.initialPositionM[0],
    config.rocket.initialPositionM[2],
    config.rocket.initialPositionM[1]
  ] as const, [config.rocket.initialPositionM]);

  useFrame(() => {
    const snapshot = snapshotRef.current;
    const platform = platformRef.current;
    const rocket = rocketRef.current;
    if (snapshot === null || platform === null || rocket === null) return;
    platform.rotation.set(snapshot.platform.rollRad, 0, -snapshot.platform.pitchRad);
    rocket.position.set(
      snapshot.rocket.positionM[0] - snapshot.platform.positionM[0],
      snapshot.rocket.positionM[2] - snapshot.platform.positionM[2],
      snapshot.rocket.positionM[1] - snapshot.platform.positionM[1]
    );
    rocket.quaternion.set(
      snapshot.rocket.attitudeWxyz[1],
      snapshot.rocket.attitudeWxyz[3],
      snapshot.rocket.attitudeWxyz[2],
      snapshot.rocket.attitudeWxyz[0]
    ).normalize();
  });

  return (
    <>
      <group ref={platformRef}>
        <RecoveryVessel config={config} surfaceTextures={surfaceTextures} />
        {frame === null ? null : (
          <CaptureCables
            frame={frame}
            config={config}
            segments={profile.cableSegments}
            reducedMotion={reducedMotion}
          />
        )}
      </group>
      <group ref={rocketRef} position={initialRocketPosition}>
        <RocketStage config={config} />
        {frame === null ? null : <RocketExhaust frame={frame} config={config} reducedMotion={reducedMotion} />}
      </group>
      {frame === null ? null : <SceneTelemetryOverlays frame={frame} config={config} />}
    </>
  );
});
