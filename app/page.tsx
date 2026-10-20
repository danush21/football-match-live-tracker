"use client";

import { useEffect, useState } from "react";
import { Scene } from "@/components/Scene";
import { EventList } from "@/components/EventList";
import { SelectionPanel } from "@/components/SelectionPanel";
import { Transport } from "@/components/Transport";
import { loadMatch } from "@/lib/loadMatch";
import type { MatchData } from "@/lib/types";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; match: MatchData }
  | { status: "error"; message: string };

export default function Page(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    loadMatch("/data", controller.signal)
      .then((match) => setState({ status: "ready", match }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, []);

  if (state.status === "loading") {
    return (
      <div className="centre-message">
        <strong>Loading match data</strong>
        <span>16 MB of tracking frames</span>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="centre-message">
        <strong>Could not load the match</strong>
        <code>{state.message}</code>
        <span>Run scripts/convert.py to regenerate public/data.</span>
      </div>
    );
  }

  return (
    <>
      <div className="canvas-host">
        <Scene match={state.match} />
      </div>
      <SelectionPanel meta={state.match.meta} />
      <EventList meta={state.match.meta} />
      <Transport meta={state.match.meta} duration={state.match.durationSeconds} />
    </>
  );
}
