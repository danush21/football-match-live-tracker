"use client";

/**
 * Source credit for the tracking data.
 *
 * Metrica Sports publish this sample data on the condition that anything
 * public acknowledges the source, so this is a requirement of deploying the
 * app rather than a decoration. Kept deliberately quiet: bottom corner, muted,
 * and it fades back until hovered.
 */
export function Credit(): React.JSX.Element {
  return (
    <a
      className="credit"
      href="https://github.com/metrica-sports/sample-data"
      target="_blank"
      rel="noreferrer noopener"
    >
      Tracking data: <strong>Metrica Sports</strong> — Sample Game 1
    </a>
  );
}
