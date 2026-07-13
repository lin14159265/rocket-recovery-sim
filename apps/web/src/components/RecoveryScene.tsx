import { memo, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { ScenarioConfig, SimulationSnapshot } from "@recovery/sim-core";

export interface RecoverySceneProps {
  frame: SimulationSnapshot | null;
  config: ScenarioConfig;
  cameraFollow: boolean;
  resetToken: number;
}

type Point3 = [number, number, number];

const UP = new THREE.Vector3(0, 1, 0);

function Beam({
  from,
  to,
  radius = 0.28,
  color = "#bf8731",
  opacity = 1
}: {
  from: Point3;
  to: Point3;
  radius?: number;
  color?: string;
  opacity?: number;
}) {
  const transform = useMemo(() => {
    const start = new THREE.Vector3(...from);
    const end = new THREE.Vector3(...to);
    const direction = end.clone().sub(start);
    const length = direction.length();
    const midpoint = start.add(end).multiplyScalar(0.5);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      UP,
      direction.normalize()
    );
    return { length, midpoint, quaternion };
  }, [from, to]);

  return (
    <mesh position={transform.midpoint} quaternion={transform.quaternion} castShadow>
      <cylinderGeometry args={[radius, radius, transform.length, 10]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.08}
        metalness={0.58}
        roughness={0.36}
        transparent={opacity < 1}
        opacity={opacity}
      />
    </mesh>
  );
}

const FrameStructure = memo(function FrameStructure({ config }: { config: ScenarioConfig }) {
  const { frameHalfWidthM: width, frameHalfDepthM: depth, frameHeightM: height } = config.platform;
  const captureY = config.platform.capturePlaneZ;
  const corners: Point3[] = [
    [-width, 0, -depth],
    [width, 0, -depth],
    [width, 0, depth],
    [-width, 0, depth]
  ];
  const top: Point3[] = corners.map(([x, , z]) => [x, height, z]);
  const capture: Point3[] = corners.map(([x, , z]) => [x, captureY, z]);

  return (
    <group>
      <mesh position={[0, -1.1, 0]} receiveShadow>
        <boxGeometry args={[width * 2.9, 1.8, depth * 2.9]} />
        <meshStandardMaterial color="#111820" metalness={0.25} roughness={0.72} />
      </mesh>
      <mesh position={[0, -0.12, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[width * 2.45, depth * 2.45]} />
        <meshStandardMaterial color="#1c232a" metalness={0.12} roughness={0.9} />
      </mesh>

      {corners.map((corner, index) => (
        <Beam
          key={`post-${index}`}
          from={corner}
          to={top[index] ?? corner}
          radius={0.45}
        />
      ))}
      {[top, capture].flatMap((level, levelIndex) => level.map((point, index) => (
        <Beam
          key={`rail-${levelIndex}-${index}`}
          from={point}
          to={level[(index + 1) % level.length] ?? point}
          radius={levelIndex === 0 ? 0.38 : 0.27}
          opacity={levelIndex === 0 ? 0.95 : 0.68}
        />
      )))}

      <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[config.rocket.radiusM * 1.5, config.rocket.radiusM * 1.72, 64]} />
        <meshBasicMaterial color="#f5b62e" toneMapped={false} />
      </mesh>
    </group>
  );
});

const RocketModel = memo(function RocketModel({ config }: { config: ScenarioConfig }) {
  const bodyLength = config.rocket.lengthM;
  const radius = config.rocket.radiusM;
  return (
    <group>
      <mesh castShadow>
        <cylinderGeometry args={[radius, radius * 0.94, bodyLength, 28]} />
        <meshStandardMaterial color="#dfe5e7" metalness={0.72} roughness={0.28} />
      </mesh>
      <mesh position={[0, bodyLength / 2 + radius * 0.75, 0]} castShadow>
        <coneGeometry args={[radius, radius * 1.55, 28]} />
        <meshStandardMaterial color="#edf1f2" metalness={0.55} roughness={0.3} />
      </mesh>
      <mesh position={[0, -bodyLength / 2 - radius * 0.6, 0]} castShadow>
        <coneGeometry args={[radius * 0.82, radius * 1.5, 24]} />
        <meshStandardMaterial color="#4e5961" metalness={0.82} roughness={0.24} />
      </mesh>
      <mesh position={[0, bodyLength * 0.13, 0]}>
        <cylinderGeometry args={[radius * 1.015, radius * 1.015, 0.58, 28]} />
        <meshStandardMaterial color="#131b22" metalness={0.48} roughness={0.4} />
      </mesh>
    </group>
  );
});

function DynamicActors({ frame, config }: { frame: SimulationSnapshot; config: ScenarioConfig }) {
  const snapshotRef = useRef(frame);
  snapshotRef.current = frame;
  const platformRef = useRef<THREE.Group>(null);
  const rocketRef = useRef<THREE.Group>(null);
  const estimateRef = useRef<THREE.Group>(null);
  const planRef = useRef<THREE.Group>(null);
  const netMaterialRef = useRef<THREE.LineBasicMaterial>(null);

  const ropeGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(24), 3));
    return geometry;
  }, []);
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
    new THREE.LineDashedMaterial({
      color: "#46dbac",
      dashSize: 1.4,
      gapSize: 1.1,
      transparent: true,
      opacity: 0.72
    })
  ), [estimateGeometry]);
  const planLine = useMemo(() => new THREE.Line(
    planGeometry,
    new THREE.LineDashedMaterial({
      color: "#ad8cff",
      dashSize: 1.6,
      gapSize: 1.2,
      transparent: true,
      opacity: 0.72
    })
  ), [planGeometry]);

  useEffect(() => () => {
    ropeGeometry.dispose();
    estimateGeometry.dispose();
    planGeometry.dispose();
    estimateLine.material.dispose();
    planLine.material.dispose();
  }, [estimateGeometry, estimateLine, planGeometry, planLine, ropeGeometry]);

  useFrame(() => {
    const snapshot = snapshotRef.current;
    const platform = snapshot.platform;
    const rocket = snapshot.rocket;
    const platformGroup = platformRef.current;
    const rocketGroup = rocketRef.current;
    if (platformGroup === null || rocketGroup === null) return;

    platformGroup.rotation.set(platform.rollRad, 0, -platform.pitchRad);
    const rocketPosition: Point3 = [
      rocket.positionM[0] - platform.positionM[0],
      rocket.positionM[2] - platform.positionM[2],
      rocket.positionM[1] - platform.positionM[1]
    ];
    rocketGroup.position.set(...rocketPosition);
    rocketGroup.quaternion.set(
      rocket.attitudeWxyz[1],
      rocket.attitudeWxyz[3],
      rocket.attitudeWxyz[2],
      rocket.attitudeWxyz[0]
    ).normalize();

    const estimate = snapshot.groundEstimate.positionM;
    estimateRef.current?.position.set(
      estimate[0] - platform.positionM[0],
      estimate[2] - platform.positionM[2],
      estimate[1] - platform.positionM[1]
    );
    planRef.current?.position.set(
      (snapshot.capturePlan?.predictedInterceptPositionM[0] ?? snapshot.net.centerM[0]) - platform.positionM[0],
      (snapshot.capturePlan?.predictedInterceptPositionM[2] ?? config.platform.capturePlaneZ) - platform.positionM[2],
      (snapshot.capturePlan?.predictedInterceptPositionM[1] ?? snapshot.net.centerM[1]) - platform.positionM[1]
    );

    const width = config.platform.frameHalfWidthM;
    const depth = config.platform.frameHalfDepthM;
    const planeY = config.platform.capturePlaneZ;
    const [centerX, centerZ] = snapshot.net.centerM;
    const [halfX, halfZ] = snapshot.net.halfSpacingM;
    const positions = ropeGeometry.getAttribute("position") as THREE.BufferAttribute;
    positions.set([
      -width, planeY, centerZ - halfZ, width, planeY, centerZ - halfZ,
      -width, planeY, centerZ + halfZ, width, planeY, centerZ + halfZ,
      centerX - halfX, planeY, -depth, centerX - halfX, planeY, depth,
      centerX + halfX, planeY, -depth, centerX + halfX, planeY, depth
    ]);
    positions.needsUpdate = true;
    ropeGeometry.computeBoundingSphere();

    const estimatePositions = estimateGeometry.getAttribute("position") as THREE.BufferAttribute;
    estimatePositions.set([
      ...rocketPosition,
      estimate[0] - platform.positionM[0],
      estimate[2] - platform.positionM[2],
      estimate[1] - platform.positionM[1]
    ]);
    estimatePositions.needsUpdate = true;
    estimateGeometry.computeBoundingSphere();
    estimateLine.computeLineDistances();

    const plan = snapshot.capturePlan?.predictedInterceptPositionM;
    if (planRef.current !== null) planRef.current.visible = plan !== undefined;
    planLine.visible = plan !== undefined;
    const planPositions = planGeometry.getAttribute("position") as THREE.BufferAttribute;
    planPositions.set([
      estimate[0] - platform.positionM[0],
      estimate[2] - platform.positionM[2],
      estimate[1] - platform.positionM[1],
      (plan?.[0] ?? snapshot.net.centerM[0]) - platform.positionM[0],
      (plan?.[2] ?? config.platform.capturePlaneZ) - platform.positionM[2],
      (plan?.[1] ?? snapshot.net.centerM[1]) - platform.positionM[1]
    ]);
    planPositions.needsUpdate = true;
    planGeometry.computeBoundingSphere();
    planLine.computeLineDistances();

    const peakTension = Math.max(...snapshot.net.tensionsN);
    const ratio = peakTension / Math.max(1, config.net.totalStrengthLimitN / 4);
    netMaterialRef.current?.color.set(ratio > 0.9 ? "#ff5f56" : ratio > 0.55 ? "#ffb13b" : "#3bd9ff");
  });

  return (
    <>
      <group ref={platformRef}>
        <FrameStructure config={config} />
        <lineSegments geometry={ropeGeometry}>
          <lineBasicMaterial ref={netMaterialRef} color="#3bd9ff" linewidth={2} toneMapped={false} />
        </lineSegments>
      </group>

      <group ref={rocketRef}>
        <RocketModel config={config} />
      </group>

      <group ref={estimateRef}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[config.rocket.radiusM * 1.25, config.rocket.radiusM * 1.55, 40]} />
          <meshBasicMaterial color="#46dbac" transparent opacity={0.82} toneMapped={false} />
        </mesh>
      </group>
      <primitive object={estimateLine} />

      <group ref={planRef}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.7, 2.1, 40]} />
          <meshBasicMaterial color="#ad8cff" transparent opacity={0.9} toneMapped={false} />
        </mesh>
      </group>
      <primitive object={planLine} />
    </>
  );
}

function TrackingCamera({
  frame,
  config,
  enabled,
  resetToken
}: {
  frame: SimulationSnapshot | null;
  config: ScenarioConfig;
  enabled: boolean;
  resetToken: number;
}) {
  const { camera } = useThree();
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const target = useMemo(() => new THREE.Vector3(), []);
  const desiredPosition = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    camera.position.set(145, 118, 150);
    camera.lookAt(0, config.platform.capturePlaneZ * 0.7, 0);
  }, [camera, config.platform.capturePlaneZ, resetToken]);

  useFrame((_, delta) => {
    if (!enabled || frameRef.current === null) return;
    const snapshot = frameRef.current;
    const rocketAltitude = snapshot.rocket.positionM[2] - snapshot.platform.positionM[2];
    const focusY = Math.max(
      config.platform.capturePlaneZ * 0.72,
      (rocketAltitude + config.platform.capturePlaneZ) * 0.5
    );
    const verticalSpan = Math.max(105, Math.abs(rocketAltitude - config.platform.capturePlaneZ) + 72);
    const distance = Math.min(1_150, verticalSpan * 0.88);
    target.set(snapshot.net.centerM[0], focusY, snapshot.net.centerM[1]);
    desiredPosition.set(distance * 0.68, focusY + distance * 0.2, distance * 0.76);
    const alpha = 1 - Math.exp(-delta * 2.8);
    camera.position.lerp(desiredPosition, alpha);
    camera.lookAt(target);
  });

  return null;
}

function SceneContents({ frame, config, cameraFollow, resetToken }: RecoverySceneProps) {
  return (
    <>
      <color attach="background" args={["#07111b"]} />
      <fog attach="fog" args={["#07111b", 190, 1_500]} />
      <ambientLight intensity={0.68} />
      <directionalLight
        position={[70, 150, 100]}
        intensity={2.1}
        color="#e9f5ff"
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <directionalLight position={[-120, 80, -80]} intensity={0.65} color="#47b5ff" />
      <Grid
        args={[420, 420]}
        position={[0, -2.2, 0]}
        cellSize={5}
        cellThickness={0.42}
        cellColor="#1c3448"
        sectionSize={25}
        sectionThickness={0.8}
        sectionColor="#2e5973"
        fadeDistance={330}
        fadeStrength={1.25}
        infiniteGrid
      />
      <mesh position={[0, -3, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[760, 760]} />
        <meshStandardMaterial color="#071a27" metalness={0.12} roughness={0.82} />
      </mesh>
      {frame === null ? <FrameStructure config={config} /> : <DynamicActors frame={frame} config={config} />}
      <TrackingCamera frame={frame} config={config} enabled={cameraFollow} resetToken={resetToken} />
      <OrbitControls
        enabled={!cameraFollow}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={55}
        maxDistance={1_500}
        maxPolarAngle={Math.PI * 0.49}
        target={[0, config.platform.capturePlaneZ * 0.7, 0]}
      />
    </>
  );
}

export function RecoveryScene(props: RecoverySceneProps) {
  return (
    <Canvas
      className="recovery-canvas"
      dpr={[1, 1.7]}
      shadows
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ position: [145, 118, 150], fov: 42, near: 0.1, far: 3_000 }}
    >
      <SceneContents {...props} />
    </Canvas>
  );
}
