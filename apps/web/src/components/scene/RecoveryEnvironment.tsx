import { memo, useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import type { ScenarioConfig, SimulationSnapshot } from "@recovery/sim-core";
import * as THREE from "three";
import stormSkyUrl from "../../assets/recovery-scene/storm-clearing-sky.webp";
import sprayAtlasUrl from "../../assets/recovery-scene/spray-steam-atlas.webp";
import type { QualityProfile } from "./scene-quality";
import { seededVisualNoise } from "./scene-math";

useTexture.preload(stormSkyUrl);
useTexture.preload(sprayAtlasUrl);

const OCEAN_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uAmplitude;
  uniform float uPeriod;
  uniform float uSeedPhase;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vCrest;

  void main() {
    vec3 displaced = position;
    float frequency = 6.2831853 / max(2.0, uPeriod);
    float phaseA = displaced.x * 0.038 + displaced.y * 0.026 + uTime * frequency + uSeedPhase;
    float phaseB = displaced.x * -0.021 + displaced.y * 0.052 + uTime * frequency * 1.34 + uSeedPhase * 1.7;
    float phaseC = displaced.x * 0.071 + displaced.y * -0.033 + uTime * frequency * 1.83 + uSeedPhase * 0.63;
    float waveA = sin(phaseA) * uAmplitude;
    float waveB = sin(phaseB) * uAmplitude * 0.46;
    float waveC = sin(phaseC) * uAmplitude * 0.22;
    displaced.z += waveA + waveB + waveC;

    float dx = cos(phaseA) * 0.038 * uAmplitude
      + cos(phaseB) * -0.021 * uAmplitude * 0.46
      + cos(phaseC) * 0.071 * uAmplitude * 0.22;
    float dy = cos(phaseA) * 0.026 * uAmplitude
      + cos(phaseB) * 0.052 * uAmplitude * 0.46
      + cos(phaseC) * -0.033 * uAmplitude * 0.22;
    vec3 objectNormal = normalize(vec3(-dx, -dy, 1.0));
    vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
    vCrest = smoothstep(uAmplitude * 0.55, uAmplitude * 1.35, waveA + waveB + waveC);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const OCEAN_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uDeepColor;
  uniform vec3 uSurfaceColor;
  uniform vec3 uSunColor;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vCrest;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float fresnel = pow(1.0 - max(dot(normal, viewDirection), 0.0), 3.0);
    vec3 sunDirection = normalize(vec3(-0.62, 0.34, -0.7));
    float sparkle = pow(max(dot(reflect(-sunDirection, normal), viewDirection), 0.0), 42.0);
    float foamNoise = sin(vWorldPosition.x * 0.86 + vWorldPosition.z * 0.31)
      * sin(vWorldPosition.z * 0.73 - vWorldPosition.x * 0.42);
    float foam = smoothstep(0.985, 1.055, vCrest + foamNoise * 0.018);
    vec3 color = mix(uDeepColor, uSurfaceColor, 0.24 + fresnel * 0.64);
    color += uSunColor * sparkle * 0.22;
    color = mix(color, vec3(0.58, 0.68, 0.72), foam * 0.04);
    float distanceFade = smoothstep(220.0, 920.0, distance(cameraPosition, vWorldPosition));
    color = mix(color, vec3(0.16, 0.23, 0.28), distanceFade * 0.55);
    gl_FragColor = vec4(color, 1.0);
  }
`;

const PARTICLE_VERTEX_SHADER = /* glsl */ `
  attribute float aSeed;
  attribute float aTile;
  uniform float uTime;
  uniform float uPointScale;
  varying float vTile;
  varying float vFade;

  void main() {
    float life = fract(uTime * (0.055 + aSeed * 0.035) + aSeed * 11.7);
    vec3 animated = position;
    animated.y += life * (5.0 + aSeed * 8.0);
    animated.x += sin(uTime * 0.7 + aSeed * 24.0) * life * 3.4;
    animated.z += cos(uTime * 0.55 + aSeed * 17.0) * life * 2.1;
    vec4 mvPosition = modelViewMatrix * vec4(animated, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = uPointScale * (10.0 + aSeed * 14.0) / max(1.0, -mvPosition.z * 0.025);
    vTile = aTile;
    vFade = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.58, 1.0, life));
  }
`;

const PARTICLE_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform vec3 uTint;
  varying float vTile;
  varying float vFade;

  void main() {
    float tile = floor(vTile + 0.5);
    float column = mod(tile, 4.0);
    float row = 3.0 - floor(tile / 4.0);
    vec2 atlasUv = (gl_PointCoord + vec2(column, row)) * 0.25;
    float mask = texture2D(uAtlas, atlasUv).r;
    float alpha = smoothstep(0.14, 0.78, mask) * vFade * 0.18;
    if (alpha < 0.012) discard;
    gl_FragColor = vec4(uTint * (0.72 + mask * 0.48), alpha);
  }
`;

const OceanSurface = memo(function OceanSurface({
  frame,
  config,
  profile
}: {
  frame: SimulationSnapshot | null;
  config: ScenarioConfig;
  profile: QualityProfile;
}) {
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uAmplitude: { value: Math.max(0.35, config.platform.heaveAmplitudeM * 1.5) },
    uPeriod: { value: config.platform.wavePeriodS },
    uSeedPhase: { value: seededVisualNoise(config.seed, 5) * Math.PI * 2 },
    uDeepColor: { value: new THREE.Color("#071923") },
    uSurfaceColor: { value: new THREE.Color("#31505d") },
    uSunColor: { value: new THREE.Color("#e7b56d") }
  }), [config.platform.heaveAmplitudeM, config.platform.wavePeriodS, config.seed]);

  useFrame(() => {
    if (materialRef.current !== null) {
      materialRef.current.uniforms.uTime!.value = frameRef.current?.timeS ?? 0;
    }
  });

  return (
    <mesh position={[0, -5.2, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[1_100, 1_100, profile.oceanSegments, profile.oceanSegments]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={OCEAN_VERTEX_SHADER}
        fragmentShader={OCEAN_FRAGMENT_SHADER}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
});

const SprayField = memo(function SprayField({
  frame,
  config,
  count,
  reducedMotion
}: {
  frame: SimulationSnapshot | null;
  config: ScenarioConfig;
  count: number;
  reducedMotion: boolean;
}) {
  const atlas = useTexture(sprayAtlasUrl);
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  useEffect(() => {
    atlas.colorSpace = THREE.NoColorSpace;
    atlas.minFilter = THREE.LinearMipmapLinearFilter;
    atlas.magFilter = THREE.LinearFilter;
    atlas.needsUpdate = true;
  }, [atlas]);

  const geometry = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const tiles = new Float32Array(count);
    const width = config.platform.frameHalfWidthM * 1.65;
    const depth = config.platform.frameHalfDepthM * 1.75;
    for (let index = 0; index < count; index += 1) {
      const seed = seededVisualNoise(config.seed, 300 + index);
      const edge = index % 4;
      const across = seededVisualNoise(config.seed, 700 + index) * 2 - 1;
      const offset = index * 3;
      positions[offset] = edge < 2 ? across * width : (edge === 2 ? -width : width);
      positions[offset + 1] = -3.6 + seededVisualNoise(config.seed, 900 + index) * 1.8;
      positions[offset + 2] = edge >= 2 ? across * depth : (edge === 0 ? -depth : depth);
      seeds[index] = seed;
      tiles[index] = [0, 1, 4, 6, 8, 10, 12, 13][index % 8] ?? 0;
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    result.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    result.setAttribute("aTile", new THREE.BufferAttribute(tiles, 1));
    return result;
  }, [config.platform.frameHalfDepthM, config.platform.frameHalfWidthM, config.seed, count]);

  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uPointScale: { value: reducedMotion ? 0.16 : 0.25 },
    uAtlas: { value: atlas },
    uTint: { value: new THREE.Color("#b8c8cc") }
  }), [atlas, reducedMotion]);

  useFrame(() => {
    if (materialRef.current !== null) materialRef.current.uniforms.uTime!.value = frameRef.current?.timeS ?? 0;
  });
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <points geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={PARTICLE_VERTEX_SHADER}
        fragmentShader={PARTICLE_FRAGMENT_SHADER}
        transparent
        depthWrite={false}
        blending={THREE.NormalBlending}
      />
    </points>
  );
});

export const RecoveryEnvironment = memo(function RecoveryEnvironment({
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
  const { scene } = useThree();
  const sky = useTexture(stormSkyUrl);
  useEffect(() => {
    sky.colorSpace = THREE.SRGBColorSpace;
    sky.mapping = THREE.EquirectangularReflectionMapping;
    sky.wrapS = THREE.RepeatWrapping;
    sky.wrapT = THREE.ClampToEdgeWrapping;
    // The generated panorama includes a photographed ocean below the horizon.
    // Crop that lower strip so the procedural sea remains the only water surface.
    sky.repeat.set(1, 0.57);
    sky.offset.set(0, 0.43);
    sky.minFilter = THREE.LinearMipmapLinearFilter;
    sky.needsUpdate = true;
    scene.environment = sky;
    scene.environmentIntensity = 0.58;
    return () => {
      if (scene.environment === sky) scene.environment = null;
    };
  }, [scene, sky]);

  return (
    <>
      <color attach="background" args={["#101a22"]} />
      <fogExp2 attach="fog" args={["#52616a", 0.00092]} />
      <mesh scale={1_450} rotation={[0, Math.PI * 0.38, 0]}>
        <sphereGeometry args={[1, 64, 32]} />
        <meshBasicMaterial map={sky} side={THREE.BackSide} toneMapped={false} fog={false} />
      </mesh>
      <hemisphereLight args={["#b7c7d2", "#182832", 1.22]} />
      <ambientLight intensity={0.42} color="#9bb0bd" />
      <directionalLight
        position={[-180, 130, -210]}
        intensity={1.45}
        color="#ffd08a"
        castShadow
        shadow-mapSize-width={profile.shadowMapSize}
        shadow-mapSize-height={profile.shadowMapSize}
        shadow-camera-left={-95}
        shadow-camera-right={95}
        shadow-camera-top={130}
        shadow-camera-bottom={-35}
        shadow-camera-near={20}
        shadow-camera-far={520}
        shadow-bias={-0.00015}
      />
      <directionalLight position={[120, 88, 160]} intensity={1.1} color="#87b5d0" />
      <directionalLight position={[96, 120, 210]} intensity={1.55} color="#c6d9e5" />
      <OceanSurface frame={frame} config={config} profile={profile} />
      <SprayField
        frame={frame}
        config={config}
        count={reducedMotion ? Math.min(12, profile.particleCount) : profile.particleCount}
        reducedMotion={reducedMotion}
      />
    </>
  );
});
