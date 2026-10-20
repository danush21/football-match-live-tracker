"use client";

import { useMemo, useState } from "react";
import { clockAt, secondsForFrame } from "@/lib/matchClock";
import { usePlayback } from "@/lib/store";
import type { MatchEvent, MatchMeta } from "@/lib/types";

/**
 * Jump-to-event sidebar.
 *
 * The match holds 1745 events, most of them ordinary passes and
 * interceptions, which would bury the moments anyone actually wants to find.
 * This keeps the ones worth seeking to: shots, set pieces, fouls and cards.
 */
const NOTABLE_TYPES = new Set(["SHOT", "SET PIECE", "CARD", "FAULT RECEIVED"]);

interface Entry {
  readonly event: MatchEvent;
  readonly seconds: number;
  readonly label: string;
  readonly detail: string;
  readonly isGoal: boolean;
}

function describe(event: MatchEvent): { label: string; detail: string; isGoal: boolean } {
  const subtype = event.subtype ?? "";
  const isGoal = event.type === "SHOT" && /\bGOAL\b/.test(subtype);
  if (isGoal) return { label: "Goal", detail: subtype.replace(/-/g, " ").toLowerCase(), isGoal };

  const pretty = (text: string): string =>
    text.toLowerCase().replace(/(^|[\s-])\w/g, (c) => c.toUpperCase());

  if (event.type === "SET PIECE") {
    return { label: pretty(subtype || "Set piece"), detail: "", isGoal };
  }
  if (event.type === "CARD") {
    return { label: `${pretty(subtype || "Card")} card`, detail: "", isGoal };
  }
  if (event.type === "FAULT RECEIVED") {
    return { label: "Foul", detail: pretty(subtype), isGoal };
  }
  return { label: "Shot", detail: pretty(subtype), isGoal };
}

export function EventList({ meta }: { readonly meta: MatchMeta }): React.JSX.Element {
  const displayTime = usePlayback((s) => s.displayTime);
  const [open, setOpen] = useState(true);

  const entries = useMemo<readonly Entry[]>(
    () =>
      meta.events
        .filter((e) => NOTABLE_TYPES.has(e.type))
        .map((event) => ({
          event,
          seconds: secondsForFrame(meta, event.frame),
          ...describe(event),
        })),
    [meta],
  );

  // The entry play has most recently passed, so the list tracks the match.
  const currentId = useMemo(() => {
    let found: number | null = null;
    for (const entry of entries) {
      if (entry.seconds <= displayTime + 0.001) found = entry.event.id;
      else break;
    }
    return found;
  }, [entries, displayTime]);

  if (!open) {
    return (
      <button
        type="button"
        className="events-reopen"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        aria-controls="key-moments"
      >
        Key moments<span>{entries.length}</span>
      </button>
    );
  }

  return (
    <aside className="events" id="key-moments" aria-label="Key moments">
      <header className="events-head">
        <span>Key moments</span>
        <span className="events-count">{entries.length}</span>
        <button
          type="button"
          className="events-toggle"
          onClick={() => setOpen(false)}
          aria-expanded
          aria-controls="key-moments"
          aria-label="Hide key moments"
          title="Hide"
        >
          &rsaquo;
        </button>
      </header>
      <ol className="events-list">
        {entries.map((entry) => {
          const clock = clockAt(meta, entry.seconds);
          const classes = [
            entry.isGoal ? "goal" : "",
            entry.event.id === currentId ? "current" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li key={entry.event.id}>
              <button
                type="button"
                className={classes}
                onClick={() => usePlayback.getState().seek(entry.seconds)}
              >
                <span className="ev-time">
                  {clock.periodLabel} {clock.time}
                </span>
                <span className={`ev-team ${entry.event.team}`} aria-hidden="true" />
                <span className="ev-label">
                  {entry.label}
                  {entry.detail !== "" ? <em>{entry.detail}</em> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
