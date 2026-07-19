import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { ScenarioConfig, SimulationSnapshot } from "@recovery/sim-core";
import * as THREE from "three";

export function CinematicCamera({
  frame,
  config,
  enabled,
  resetToken,
  reducedMotion
}: {
  frame: SimulationSnapshot | null;
  config: ScenarioConfig;
  enabled: boolean;
  resetToken: number;
  reducedMotion: boolean;
}) {
  const { camera } = useThree();
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const target = useMemo(() => new THREE.Vector3(), []);
  const desiredTarget = useMemo(() => new THREE.Vector3(), []);
  const desiredPosition = useMemo(() => new THREE.Vector3(), []);
  const snapOnNextFrame = useRef(true);

  useEffect(() => {
    camera.position.set(126, 102, 146);
    target.set(0, config.platform.capturePlaneZ * 0.7, 0);
    camera.lookAt(target);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = 43;
      camera.updateProjectionMatrix();
    }
    snapOnNextFrame.current = true;
  }, [camera, config.platform.capturePlaneZ, resetToken, target]);

  useFrame((_, delta) => {
    if (!enabled || frameRef.current === null) return;
    const snapshot = frameRef.current;
    const relativeX = snapshot.rocket.positionM[0] - snapshot.platform.positionM[0];
    const relativeY = snapshot.rocket.positionM[2] - snapshot.platform.positionM[2];
    const relativeZ = snapshot.rocket.positionM[1] - snapshot.platform.positionM[1];
    const captureY = config.platform.capturePlaneZ;
    const verticalGap = Math.abs(relativeY - captureY);
    const highAltitude = Math.min(1, Math.max(0, (verticalGap - 80) / 600));
    const lowAltitudeFocusY = Math.max(captureY * 0.68, (relativeY + captureY * 0.72) * 0.58);
    const rocketFocusY = relativeY - config.rocket.lengthM * 0.04;
    const rocketFocusBlend = Math.pow(highAltitude, 1.55);
    const focusY = THREE.MathUtils.lerp(lowAltitudeFocusY, rocketFocusY, rocketFocusBlend);
    const lowAltitudeDistance = Math.max(112, Math.min(235, verticalGap * 1.15 + 118));
    const highAltitudeDistance = Math.max(164, config.rocket.lengthM * 2.7);
    const distance = THREE.MathUtils.lerp(lowAltitudeDistance, highAltitudeDistance, rocketFocusBlend);
    const lateralBias = Math.min(24, Math.hypot(relativeX, relativeZ) * 0.18);
    desiredTarget.set(
      relativeX * 0.28 + snapshot.net.centerM[0] * 0.45,
      focusY,
      relativeZ * 0.28 + snapshot.net.centerM[1] * 0.45
    );
    desiredPosition.set(
      distance * 0.59 + lateralBias,
      focusY + distance * (0.17 + highAltitude * 0.03),
      distance * 0.73
    );

    const isContact = snapshot.supervisorState === "CONTACT" || snapshot.supervisorState === "ARREST";
    if (isContact && !reducedMotion) {
      const envelope = snapshot.supervisorState === "CONTACT" ? 1 : 0.52;
      desiredPosition.x += Math.sin(snapshot.timeS * 31.7) * 0.42 * envelope;
      desiredPosition.y += Math.sin(snapshot.timeS * 38.4 + 0.7) * 0.25 * envelope;
      desiredPosition.z += Math.cos(snapshot.timeS * 27.2) * 0.35 * envelope;
    }

    const positionAlpha = 1 - Math.exp(-delta * (isContact ? 4.4 : 2.6));
    const targetAlpha = 1 - Math.exp(-delta * 3.6);
    if (snapOnNextFrame.current) {
      camera.position.copy(desiredPosition);
      target.copy(desiredTarget);
      snapOnNextFrame.current = false;
    } else {
      camera.position.lerp(desiredPosition, positionAlpha);
      target.lerp(desiredTarget, targetAlpha);
    }
    camera.lookAt(target);

    if (camera instanceof THREE.PerspectiveCamera) {
      const desiredFov = 42 + highAltitude * 5 + (isContact ? 1.2 : 0);
      camera.fov += (desiredFov - camera.fov) * (1 - Math.exp(-delta * 2.2));
      camera.updateProjectionMatrix();
    }
  });

  return null;
}
