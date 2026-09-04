"use client";

import { useEffect, useMemo } from "react";
import { DoubleSide } from "three";
import { createPitchTexture } from "@/lib/pitchTexture";
import type { PitchDimensions } from "@/lib/types";

const GOAL_WIDTH = 7.32;
const GOAL_HEIGHT = 2.44;
const POST_RADIUS = 0.06;

function Goal({ x, facing }: { x: number; facing: 1 | -1 }): React.JSX.Element {
  const halfGoal = GOAL_WIDTH / 2;
  // Posts sit just behind the goal line so they never z-fight with the marking.
  const postX = x + facing * POST_RADIUS;
  return (
    <group>
      {[-halfGoal, halfGoal].map((z) => (
        <mesh key={z} position={[postX, GOAL_HEIGHT / 2, z]} castShadow>
          <cylinderGeometry args={[POST_RADIUS, POST_RADIUS, GOAL_HEIGHT, 8]} />
          <meshStandardMaterial color="#f2f5f7" roughness={0.6} />
        </mesh>
      ))}
      <mesh position={[postX, GOAL_HEIGHT, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[POST_RADIUS, POST_RADIUS, GOAL_WIDTH, 8]} />
        <meshStandardMaterial color="#f2f5f7" roughness={0.6} />
      </mesh>
    </group>
  );
}

export function Pitch({ pitch }: { pitch: PitchDimensions }): React.JSX.Element {
  const texture = useMemo(
    () => createPitchTexture(pitch.length, pitch.width),
    [pitch.length, pitch.width],
  );

  useEffect(() => () => texture.dispose(), [texture]);

  const halfLength = pitch.length / 2;

  return (
    <group>
      {/* Surround, so the pitch does not float in the void. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[pitch.length + 40, pitch.width + 30]} />
        <meshStandardMaterial color="#16321f" roughness={1} />
      </mesh>

      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[pitch.length, pitch.width]} />
        <meshStandardMaterial map={texture} roughness={0.95} side={DoubleSide} />
      </mesh>

      <Goal x={-halfLength} facing={-1} />
      <Goal x={halfLength} facing={1} />
    </group>
  );
}
