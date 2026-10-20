"use client";

import { CAMERA_LABELS } from "@/lib/cameraPresets";
import { usePlayback } from "@/lib/store";
import type { MatchMeta } from "@/lib/types";

/**
 * Details of the player the viewer has clicked.
 *
 * Speed is published by the render loop at 10Hz rather than read per frame:
 * a figure that changes sixty times a second is unreadable, and pushing it
 * through React that often would re-render the tree on every frame.
 */
export function SelectionPanel({ meta }: { readonly meta: MatchMeta }): React.JSX.Element | null {
  const selected = usePlayback((s) => s.selectedPlayer);
  const speed = usePlayback((s) => s.selectedSpeed);
  const cameraMode = usePlayback((s) => s.cameraMode);

  if (selected === null) return null;
  const player = meta.players.find((p) => p.id === selected);
  if (player === undefined) return null;

  const following = cameraMode === "player";

  return (
    <div className="selection">
      <div className="sel-head">
        <span className={`sel-dot ${player.team}`} aria-hidden="true" />
        <span className="sel-number">{player.jersey}</span>
        <span className="sel-team">{player.team}</span>
        <button
          type="button"
          className="sel-close"
          onClick={() => usePlayback.getState().selectPlayer(null)}
          aria-label="Clear selection"
          title="Clear"
        >
          &times;
        </button>
      </div>

      <div className="sel-stat">
        <span className="sel-value">{speed.toFixed(1)}</span>
        <span className="sel-unit">m/s</span>
      </div>

      <button
        type="button"
        className={`sel-follow ${following ? "on" : ""}`}
        onClick={() =>
          usePlayback.getState().setCameraMode(following ? "broadcast" : "player")
        }
      >
        {following ? "Stop following" : CAMERA_LABELS.player}
      </button>
    </div>
  );
}
