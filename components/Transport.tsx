"use client";

import { useEffect } from "react";
import { usePlayback } from "@/lib/store";

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/**
 * Phase 2 transport: just enough to press play. The scrub bar, speed control,
 * camera presets and event list arrive in phase 4.
 */
export function Transport({ duration }: { duration: number }): React.JSX.Element {
  const playing = usePlayback((s) => s.playing);
  const displayTime = usePlayback((s) => s.displayTime);
  const toggle = usePlayback((s) => s.toggle);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.code === "Space") {
        event.preventDefault();
        usePlayback.getState().toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="transport">
      <button type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
        {playing ? "❚❚" : "▶"}
      </button>
      <span className="clock">
        {formatClock(displayTime)} / {formatClock(duration)}
      </span>
      <span className="hint">space to play · drag to orbit</span>
    </div>
  );
}
