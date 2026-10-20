"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CAMERA_LABELS, CAMERA_MODES } from "@/lib/cameraPresets";
import { clockAt, formatMinutesSeconds, periodBounds } from "@/lib/matchClock";
import { PLAYBACK_SPEEDS, usePlayback, type PlaybackSpeed } from "@/lib/store";
import type { MatchMeta } from "@/lib/types";

interface TransportProps {
  readonly meta: MatchMeta;
  readonly duration: number;
}

export function Transport({ meta, duration }: TransportProps): React.JSX.Element {
  const playing = usePlayback((s) => s.playing);
  const speed = usePlayback((s) => s.speed);
  const displayTime = usePlayback((s) => s.displayTime);
  const cameraMode = usePlayback((s) => s.cameraMode);

  /** While dragging, follow the handle rather than the clock it is chasing. */
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const shown = scrubbing ?? displayTime;

  const clock = useMemo(() => clockAt(meta, shown), [meta, shown]);
  const bounds = useMemo(() => periodBounds(meta, duration), [meta, duration]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target;
      if (target instanceof HTMLElement && target.tagName === "INPUT") return;
      if (event.code === "Space") {
        event.preventDefault();
        usePlayback.getState().toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onScrub = useCallback((value: number) => {
    setScrubbing(value);
    usePlayback.getState().seek(value);
  }, []);

  const progress = duration > 0 ? Math.min(1, Math.max(0, shown / duration)) : 0;

  return (
    <div className="transport">
      <button
        type="button"
        className="transport-play"
        onClick={() => usePlayback.getState().toggle()}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "❚❚" : "▶"}
      </button>

      <div className="clock" aria-live="off">
        <span className="clock-period">{clock.periodLabel}</span>
        <span className="clock-time">{clock.time}</span>
      </div>

      <div className="scrub">
        <div className="scrub-track">
          {bounds.map((b) => (
            <span
              key={b.period}
              className="scrub-period"
              style={{ left: `${b.from * 100}%`, width: `${(b.to - b.from) * 100}%` }}
            />
          ))}
          {/* Period boundaries: the teams change ends at each one. */}
          {bounds.slice(0, -1).map((b) => (
            <span key={`mark-${b.period}`} className="scrub-mark" style={{ left: `${b.to * 100}%` }} />
          ))}
          <span className="scrub-fill" style={{ width: `${progress * 100}%` }} />
          <span className="scrub-handle" style={{ left: `${progress * 100}%` }} />
        </div>
        <input
          className="scrub-input"
          type="range"
          min={0}
          max={duration}
          step={0.04}
          value={shown}
          aria-label="Match time"
          onChange={(e) => onScrub(Number(e.currentTarget.value))}
          onPointerUp={() => setScrubbing(null)}
          onBlur={() => setScrubbing(null)}
        />
      </div>

      <div className="elapsed">{formatMinutesSeconds(shown)} / {formatMinutesSeconds(duration)}</div>

      <div className="segmented" role="group" aria-label="Playback speed">
        {PLAYBACK_SPEEDS.map((value: PlaybackSpeed) => (
          <button
            key={value}
            type="button"
            className={value === speed ? "on" : ""}
            onClick={() => usePlayback.getState().setSpeed(value)}
          >
            {value}&times;
          </button>
        ))}
      </div>

      <div className="segmented" role="group" aria-label="Camera">
        {CAMERA_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={mode === cameraMode ? "on" : ""}
            onClick={() => usePlayback.getState().setCameraMode(mode)}
          >
            {CAMERA_LABELS[mode]}
          </button>
        ))}
      </div>
    </div>
  );
}
