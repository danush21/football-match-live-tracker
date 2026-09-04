"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Mesh } from "three";
import { FrameSampler } from "@/lib/sampler";
import { usePlayback } from "@/lib/store";
import type { MatchData } from "@/lib/types";

const PLAYER_RADIUS = 0.4;
const PLAYER_HEIGHT = 1.8;
const BALL_RADIUS = 0.11;

const TEAM_COLOUR = { home: "#3d7fe8", away: "#e8443d" } as const;

/** Longest step the clock will take in one render frame (tab-switch guard). */
const MAX_DELTA = 0.1;
/** How often the render clock is mirrored into React state, seconds. */
const DISPLAY_INTERVAL = 0.1;

export function Replay({ match }: { match: MatchData }): React.JSX.Element {
  const sampler = useMemo(() => new FrameSampler(match), [match]);

  const playerMeshes = useRef<Array<Mesh | null>>([]);
  const ballMesh = useRef<Mesh | null>(null);

  /** Entity slot for each player, in the order they are rendered. */
  const slots = useMemo(
    () => match.meta.players.map((p) => match.entityIndex.get(p.id) ?? -1),
    [match],
  );

  const clock = useRef(0);
  const sinceDisplayPush = useRef(0);

  const halfLength = match.meta.pitch.length / 2;
  const halfWidth = match.meta.pitch.width / 2;

  useFrame((_, rawDelta) => {
    const store = usePlayback.getState();

    const seek = store.consumeSeek();
    if (seek !== null) {
      clock.current = Math.min(Math.max(seek, 0), sampler.duration);
    } else if (store.playing) {
      clock.current += Math.min(rawDelta, MAX_DELTA) * store.speed;
      if (clock.current >= sampler.duration) {
        clock.current = sampler.duration;
        store.pause();
      }
    }

    sampler.sample(clock.current);

    const { positions, present } = sampler;

    for (let n = 0; n < slots.length; n += 1) {
      const mesh = playerMeshes.current[n];
      if (!mesh) continue;
      const slot = slots[n]!;
      if (present[slot] === 1) {
        const o = slot * 2;
        mesh.position.set(
          positions[o]! - halfLength,
          PLAYER_HEIGHT / 2,
          positions[o + 1]! - halfWidth,
        );
        mesh.visible = true;
      } else {
        mesh.visible = false;
      }
    }

    const ball = ballMesh.current;
    if (ball) {
      if (present[0] === 1) {
        // The source is 2D, so the ball has no height and stays on the deck.
        ball.position.set(positions[0]! - halfLength, BALL_RADIUS, positions[1]! - halfWidth);
        ball.visible = true;
      } else {
        ball.visible = false;
      }
    }

    sinceDisplayPush.current += rawDelta;
    if (sinceDisplayPush.current >= DISPLAY_INTERVAL) {
      sinceDisplayPush.current = 0;
      if (store.displayTime !== clock.current) store.setDisplayTime(clock.current);
    }
  });

  return (
    <group>
      {match.meta.players.map((player, n) => (
        <mesh
          key={player.id}
          ref={(el) => {
            playerMeshes.current[n] = el;
          }}
          visible={false}
          castShadow
        >
          <cylinderGeometry args={[PLAYER_RADIUS, PLAYER_RADIUS, PLAYER_HEIGHT, 12]} />
          <meshStandardMaterial color={TEAM_COLOUR[player.team]} roughness={0.7} />
        </mesh>
      ))}

      <mesh ref={ballMesh} visible={false} castShadow>
        <sphereGeometry args={[BALL_RADIUS, 16, 12]} />
        <meshStandardMaterial color="#fdfdfd" roughness={0.4} />
      </mesh>
    </group>
  );
}
