import { memo, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { ScenarioConfig, SimulationSnapshot } from "@recovery/sim-core";
import * as THREE from "three";

export const SceneTelemetryOverlays = memo(function SceneTelemetryOverlays({
  frame,
  config
}: {
  frame: SimulationSnapshot;
  config: ScenarioConfig;
}) {
  const snapshotRef = useRef(frame);
  snapshotRef.current = frame;
  const estimateRef = useRef<THREE.Group>(null);
  const planRef = useRef<THREE.Group>(null);
  const uncertaintyRef = useRef<THREE.Group>(null);

  const estimateGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    return geometry;
  }, []);
  const planGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    return geometry;
  }, []);
  const estimateLine = useMemo(() => new THREE.Line(
    estimateGeometry,
    new THREE.LineDashedMaterial({ color: "#45d8a7", dashSize: 1.4, gapSize: 1.1, transparent: true, opacity: 0.68 })
  ), [estimateGeometry]);
  const planLine = useMemo(() => new THREE.Line(
    planGeometry,
    new THREE.LineDashedMaterial({ color: "#b69aeb", dashSize: 1.6, gapSize: 1.2, transparent: true, opacity: 0.68 })
  ), [planGeometry]);

  useEffect(() => () => {
    estimateGeometry.dispose();
    planGeometry.dispose();
    estimateLine.material.dispose();
    planLine.material.dispose();
  }, [estimateGeometry, estimateLine, planGeometry, planLine]);

  useFrame(() => {
    const snapshot = snapshotRef.current;
    const platform = snapshot.platform.positionM;
    const rocketPosition = [
      snapshot.rocket.positionM[0] - platform[0],
      snapshot.rocket.positionM[2] - platform[2],
      snapshot.rocket.positionM[1] - platform[1]
    ] as const;
    const estimate = snapshot.groundEstimate.positionM;
    const estimatePosition = [
      estimate[0] - platform[0],
      estimate[2] - platform[2],
      estimate[1] - platform[1]
    ] as const;
    estimateRef.current?.position.set(...estimatePosition);

    const plan = snapshot.capturePlan?.predictedInterceptPositionM;
    const planPosition = [
      (plan?.[0] ?? snapshot.net.centerM[0]) - platform[0],
      (plan?.[2] ?? config.platform.capturePlaneZ) - platform[2],
      (plan?.[1] ?? snapshot.net.centerM[1]) - platform[1]
    ] as const;
    planRef.current?.position.set(...planPosition);
    uncertaintyRef.current?.position.set(...planPosition);

    const estimatePositions = estimateGeometry.getAttribute("position") as THREE.BufferAttribute;
    estimatePositions.set([...rocketPosition, ...estimatePosition]);
    estimatePositions.needsUpdate = true;
    estimateGeometry.computeBoundingSphere();
    estimateLine.computeLineDistances();

    const isPlanVisible = plan !== undefined;
    if (planRef.current !== null) planRef.current.visible = isPlanVisible;
    if (uncertaintyRef.current !== null) {
      uncertaintyRef.current.visible = isPlanVisible;
      uncertaintyRef.current.scale.set(
        Math.max(0.8, (snapshot.capturePlan?.predictionUncertaintyM[0] ?? 0) * 3),
        Math.max(0.8, (snapshot.capturePlan?.predictionUncertaintyM[1] ?? 0) * 3),
        1
      );
    }
    planLine.visible = isPlanVisible;
    const planPositions = planGeometry.getAttribute("position") as THREE.BufferAttribute;
    planPositions.set([...estimatePosition, ...planPosition]);
    planPositions.needsUpdate = true;
    planGeometry.computeBoundingSphere();
    planLine.computeLineDistances();
  });

  return (
    <>
      <group ref={estimateRef}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[config.rocket.radiusM * 1.25, config.rocket.radiusM * 1.52, 40]} />
          <meshBasicMaterial color="#45d8a7" transparent opacity={0.7} toneMapped={false} />
        </mesh>
      </group>
      <primitive object={estimateLine} />
      <group ref={planRef}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.7, 2.05, 40]} />
          <meshBasicMaterial color="#b69aeb" transparent opacity={0.8} toneMapped={false} />
        </mesh>
      </group>
      <group ref={uncertaintyRef} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh>
          <circleGeometry args={[1, 48]} />
          <meshBasicMaterial color="#b69aeb" transparent opacity={0.055} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, 0.01]}>
          <ringGeometry args={[0.985, 1, 48]} />
          <meshBasicMaterial color="#b69aeb" transparent opacity={0.58} toneMapped={false} />
        </mesh>
      </group>
      <primitive object={planLine} />
    </>
  );
});
