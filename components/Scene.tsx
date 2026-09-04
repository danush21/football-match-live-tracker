"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { DevHandle } from "./DevHandle";
import { Pitch } from "./Pitch";
import { Replay } from "./Replay";
import type { MatchData } from "@/lib/types";

export function Scene({ match }: { match: MatchData }): React.JSX.Element {
  const { pitch } = match.meta;

  return (
    <Canvas
      shadows
      camera={{ position: [0, 42, 78], fov: 42, near: 0.5, far: 400 }}
      gl={{ antialias: true }}
    >
      <color attach="background" args={["#0a0d10"]} />
      <fog attach="fog" args={["#0a0d10", 160, 320]} />

      <hemisphereLight args={["#bcd6ff", "#20301f", 1.1]} />
      <directionalLight
        position={[45, 70, 30]}
        intensity={1.9}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={50}
        shadow-camera-bottom={-50}
        shadow-camera-near={1}
        shadow-camera-far={200}
        shadow-bias={-0.0005}
      />

      <DevHandle />
      <Pitch pitch={pitch} />
      <Replay match={match} />

      <OrbitControls
        makeDefault
        target={[0, 0, 0]}
        minDistance={20}
        maxDistance={220}
        maxPolarAngle={Math.PI / 2 - 0.04}
        enableDamping
        dampingFactor={0.08}
      />
    </Canvas>
  );
}
