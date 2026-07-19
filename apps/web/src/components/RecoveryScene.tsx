import { memo, useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, PerformanceMonitor } from "@react-three/drei";
import type { ScenarioConfig, SimulationSnapshot } from "@recovery/sim-core";
import * as THREE from "three";
import { CinematicCamera } from "./scene/CinematicCamera";
import { RecoveryActors } from "./scene/RecoveryActors";
import { RecoveryEnvironment } from "./scene/RecoveryEnvironment";
import {
  QUALITY_PROFILES,
  observeAutoQuality,
  type AutoQualityState,
  type ResolvedSceneQuality,
  type SceneQualityPreference
} from "./scene/scene-quality";

const GL_OPTIONS_ANTIALIASED = {
  antialias: true,
  powerPreference: "high-performance",
  alpha: false,
  stencil: false,
  toneMapping: THREE.ACESFilmicToneMapping,
  outputColorSpace: THREE.SRGBColorSpace
} as const;

const GL_OPTIONS_LIGHTWEIGHT = {
  ...GL_OPTIONS_ANTIALIASED,
  antialias: false
} as const;

const CAMERA_SETTINGS = {
  position: [126, 102, 146] as [number, number, number],
  fov: 43,
  near: 0.2,
  far: 3_200
};

const configureRenderer = ({ gl }: { gl: THREE.WebGLRenderer }) => {
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = 0.8;
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFShadowMap;
};

export interface RecoverySceneProps {
  frame: SimulationSnapshot | null;
  config: ScenarioConfig;
  cameraFollow: boolean;
  resetToken: number;
  qualityPreference: SceneQualityPreference;
  resolvedQuality: ResolvedSceneQuality;
  onResolvedQualityChange: (quality: ResolvedSceneQuality) => void;
}

export const supportsWebGL2 = (): boolean => {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    const supported = context !== null;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return supported;
  } catch {
    return false;
  }
};

const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
};

function AdaptiveQualityMonitor({
  preference,
  resolved,
  onResolvedChange
}: {
  preference: SceneQualityPreference;
  resolved: ResolvedSceneQuality;
  onResolvedChange: (quality: ResolvedSceneQuality) => void;
}) {
  const stateRef = useRef<AutoQualityState>({
    resolved,
    poorWindows: 0,
    stableWindows: 0,
    lastChangeMs: -30_000
  });

  useEffect(() => {
    stateRef.current = { ...stateRef.current, resolved };
  }, [resolved]);

  if (preference !== "auto") return null;
  const observe = (signal: "poor" | "stable") => {
    const next = observeAutoQuality(stateRef.current, signal, performance.now());
    stateRef.current = next;
    if (next.resolved !== resolved) onResolvedChange(next.resolved);
  };

  return (
    <PerformanceMonitor
      bounds={(refreshRate) => [Math.min(42, refreshRate * 0.62), Math.min(58, refreshRate * 0.9)]}
      flipflops={4}
      onDecline={() => observe("poor")}
      onIncline={() => observe("stable")}
      onFallback={() => onResolvedChange("low")}
    />
  );
}

const SceneContents = memo(function SceneContents(props: RecoverySceneProps & { reducedMotion: boolean }) {
  const profile = QUALITY_PROFILES[props.resolvedQuality] ?? QUALITY_PROFILES.low;
  return (
    <>
      <RecoveryEnvironment
        frame={props.frame}
        config={props.config}
        profile={profile}
        reducedMotion={props.reducedMotion}
      />
      <RecoveryActors
        frame={props.frame}
        config={props.config}
        profile={profile}
        reducedMotion={props.reducedMotion}
      />
      <CinematicCamera
        frame={props.frame}
        config={props.config}
        enabled={props.cameraFollow}
        resetToken={props.resetToken}
        reducedMotion={props.reducedMotion}
      />
      <OrbitControls
        enabled={!props.cameraFollow}
        makeDefault
        enableDamping
        dampingFactor={0.075}
        minDistance={42}
        maxDistance={1_500}
        maxPolarAngle={Math.PI * 0.49}
        target={[0, props.config.platform.capturePlaneZ * 0.72, 0]}
      />
      <AdaptiveQualityMonitor
        preference={props.qualityPreference}
        resolved={props.resolvedQuality}
        onResolvedChange={props.onResolvedQualityChange}
      />
    </>
  );
});

export function RecoveryScene(props: RecoverySceneProps) {
  const reducedMotion = useReducedMotion();
  const [webgl2Supported] = useState(supportsWebGL2);
  if (!webgl2Supported) {
    return (
      <div className="scene-webgl-fallback" role="status">
        <strong>增强三维效果不可用</strong>
        <span>当前浏览器未提供可用的 WebGL2；控制算法、图表和回放仍可正常使用。</span>
      </div>
    );
  }
  if (props.frame === null) {
    return (
      <div className="scene-vfx-loading" role="status">
        <strong>正在装载确定性三维回放</strong>
        <span>等待物理快照后再分配高画质 WebGL 目标。</span>
      </div>
    );
  }
  const profile = QUALITY_PROFILES[props.resolvedQuality] ?? QUALITY_PROFILES.low;
  // The current ANGLE/D3D path returns an all-white canvas for a 1.5 DPR
  // WebGL target at this panel size. Preserve the high-tier scene budgets,
  // while capping the verified render target to the stable 1.25 DPR path.
  const renderDpr = Math.min(profile.dpr, 1.25);
  return (
    <Canvas
      key={profile.id}
      className="recovery-canvas"
      dpr={renderDpr}
      gl={profile.antialias ? GL_OPTIONS_ANTIALIASED : GL_OPTIONS_LIGHTWEIGHT}
      onCreated={configureRenderer}
      camera={CAMERA_SETTINGS}
    >
      <SceneContents {...props} reducedMotion={reducedMotion} />
    </Canvas>
  );
}
