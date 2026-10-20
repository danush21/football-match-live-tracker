"use client";

import { create } from "zustand";
import type { CameraMode } from "./cameraPresets.ts";

/**
 * Playback state that React needs to see.
 *
 * The authoritative clock deliberately does NOT live here: it advances every
 * render frame, and pushing that through Zustand would re-render subscribers
 * 60+ times a second. The scene owns the clock in a ref and publishes a
 * throttled copy via setDisplayTime for the UI to read.
 */

export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

interface PlaybackState {
  playing: boolean;
  speed: PlaybackSpeed;
  /** Throttled mirror of the render clock, seconds from the first frame. */
  displayTime: number;
  /** Set by seek(); the scene consumes it and resets it to null. */
  pendingSeek: number | null;
  cameraMode: CameraMode;
  /** Player id the viewer has clicked, or null. */
  selectedPlayer: string | null;
  /** Whether jersey numbers float above every player. */
  showNumbers: boolean;
  /** Speed of the selected player, m/s, published at the display rate. */
  selectedSpeed: number;

  play: () => void;
  pause: () => void;
  toggle: () => void;
  setSpeed: (speed: PlaybackSpeed) => void;
  seek: (seconds: number) => void;
  consumeSeek: () => number | null;
  setDisplayTime: (seconds: number) => void;
  setCameraMode: (mode: CameraMode) => void;
  selectPlayer: (id: string | null) => void;
  setSelectedSpeed: (speed: number) => void;
  toggleNumbers: () => void;
}

export const usePlayback = create<PlaybackState>((set, get) => ({
  playing: false,
  speed: 1,
  displayTime: 0,
  pendingSeek: null,
  cameraMode: "broadcast",
  selectedPlayer: null,
  showNumbers: false,
  selectedSpeed: 0,

  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  toggle: () => set((s) => ({ playing: !s.playing })),
  setSpeed: (speed) => set({ speed }),
  seek: (seconds) => set({ pendingSeek: seconds, displayTime: seconds }),
  consumeSeek: () => {
    const pending = get().pendingSeek;
    if (pending !== null) set({ pendingSeek: null });
    return pending;
  },
  setDisplayTime: (seconds) => set({ displayTime: seconds }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
  selectPlayer: (selectedPlayer) =>
    set((s) => ({
      selectedPlayer,
      // Following nobody is not a camera mode; fall back when deselecting.
      cameraMode: selectedPlayer === null && s.cameraMode === "player" ? "broadcast" : s.cameraMode,
    })),
  setSelectedSpeed: (selectedSpeed) => set({ selectedSpeed }),
  toggleNumbers: () => set((s) => ({ showNumbers: !s.showNumbers })),
}));

// Development-only handle so the playback clock can be driven from the console
// while verifying a phase. Not referenced by application code.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as { __playback?: typeof usePlayback }).__playback = usePlayback;
}
