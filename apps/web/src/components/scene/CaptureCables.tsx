import { memo, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { ScenarioConfig, SimulationSnapshot } from "@recovery/sim-core";
import * as THREE from "three";
import { sampleCaptureCables, type ScenePoint3 } from "./scene-math";

const UP = new THREE.Vector3(0, 1, 0);
const STEEL_COLOR = new THREE.Color("#70787b");
const AMBER_COLOR = new THREE.Color("#d99a42");
const BROKEN_COLOR = new THREE.Color("#a74e39");

const contactDeformation = (snapshot: SimulationSnapshot, strengthLimitN: number): number => {
  if (!(["CONTACT", "ARREST", "SECURED", "BROKEN"] as const).includes(
    snapshot.supervisorState as "CONTACT" | "ARREST" | "SECURED" | "BROKEN"
  )) return 0;
  const loadRatio = Math.max(...snapshot.net.tensionsN) / Math.max(1, strengthLimitN / 4);
  if (snapshot.supervisorState === "CONTACT") return Math.min(0.5, 0.16 + loadRatio * 0.32);
  if (snapshot.supervisorState === "SECURED") return 0.72;
  if (snapshot.supervisorState === "BROKEN") return 0.82;
  return Math.min(0.9, 0.42 + loadRatio * 0.44);
};

const attachmentPointInPlatformFrame = (
  snapshot: SimulationSnapshot,
  config: ScenarioConfig,
  target: THREE.Vector3,
  scratchQuaternion: THREE.Quaternion,
  platformQuaternion: THREE.Quaternion
): ScenePoint3 => {
  target.set(0, config.rocket.lengthM * 0.3, 0);
  scratchQuaternion.set(
    snapshot.rocket.attitudeWxyz[1],
    snapshot.rocket.attitudeWxyz[3],
    snapshot.rocket.attitudeWxyz[2],
    snapshot.rocket.attitudeWxyz[0]
  ).normalize();
  target.applyQuaternion(scratchQuaternion);
  target.add(new THREE.Vector3(
    snapshot.rocket.positionM[0] - snapshot.platform.positionM[0],
    snapshot.rocket.positionM[2] - snapshot.platform.positionM[2],
    snapshot.rocket.positionM[1] - snapshot.platform.positionM[1]
  ));
  platformQuaternion.setFromEuler(new THREE.Euler(snapshot.platform.rollRad, 0, -snapshot.platform.pitchRad)).invert();
  target.applyQuaternion(platformQuaternion);
  return [target.x, target.y, target.z];
};

export const CaptureCables = memo(function CaptureCables({
  frame,
  config,
  segments,
  reducedMotion
}: {
  frame: SimulationSnapshot;
  config: ScenarioConfig;
  segments: number;
  reducedMotion: boolean;
}) {
  const snapshotRef = useRef(frame);
  snapshotRef.current = frame;
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => new THREE.CylinderGeometry(0.105, 0.105, 1, 8, 1), []);
  const material = useMemo(() => new THREE.MeshStandardMaterial({
    color: "#ffffff",
    metalness: 0.88,
    roughness: 0.32,
    vertexColors: true
  }), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const start = useMemo(() => new THREE.Vector3(), []);
  const end = useMemo(() => new THREE.Vector3(), []);
  const midpoint = useMemo(() => new THREE.Vector3(), []);
  const direction = useMemo(() => new THREE.Vector3(), []);
  const attachment = useMemo(() => new THREE.Vector3(), []);
  const scratchQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const platformQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const instanceCount = 4 * Math.max(4, Math.floor(segments));

  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);

  useFrame(() => {
    const snapshot = snapshotRef.current;
    const mesh = meshRef.current;
    if (mesh === null) return;
    const curves = sampleCaptureCables({
      frameHalfWidthM: config.platform.frameHalfWidthM,
      frameHalfDepthM: config.platform.frameHalfDepthM,
      capturePlaneY: config.platform.capturePlaneZ,
      centerM: snapshot.net.centerM,
      halfSpacingM: snapshot.net.halfSpacingM,
      attachmentPoint: attachmentPointInPlatformFrame(
        snapshot,
        config,
        attachment,
        scratchQuaternion,
        platformQuaternion
      ),
      rocketRadiusM: config.rocket.radiusM,
      deformation: contactDeformation(snapshot, config.net.totalStrengthLimitN),
      timeS: snapshot.timeS,
      seed: config.seed,
      reducedMotion,
      segments
    });

    let instanceIndex = 0;
    for (const curve of curves) {
      const tensionRatio = snapshot.net.tensionsN[curve.tensionIndex]
        / Math.max(1, config.net.totalStrengthLimitN / 4);
      const color = snapshot.supervisorState === "BROKEN"
        ? BROKEN_COLOR
        : STEEL_COLOR.clone().lerp(AMBER_COLOR, Math.min(1, Math.max(0, tensionRatio)));
      for (let index = 1; index < curve.points.length; index += 1) {
        const from = curve.points[index - 1]!;
        const to = curve.points[index]!;
        start.set(...from);
        end.set(...to);
        direction.copy(end).sub(start);
        const length = direction.length();
        midpoint.copy(start).add(end).multiplyScalar(0.5);
        dummy.position.copy(midpoint);
        dummy.quaternion.setFromUnitVectors(UP, direction.normalize());
        dummy.scale.set(1, length, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(instanceIndex, dummy.matrix);
        mesh.setColorAt(instanceIndex, color);
        instanceIndex += 1;
      }
    }
    mesh.count = instanceIndex;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, instanceCount]}
      castShadow
      receiveShadow
      frustumCulled={false}
    />
  );
});
