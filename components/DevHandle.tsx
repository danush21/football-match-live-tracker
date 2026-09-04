"use client";

import { useThree } from "@react-three/fiber";

/**
 * Development-only: publishes the R3F state on window.__three so the scene can
 * be inspected and the camera driven from the console while verifying a phase.
 * Renders nothing and is not referenced by application code.
 */
export function DevHandle(): null {
  const state = useThree();

  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
    (window as unknown as { __three?: unknown }).__three = state;
  }

  return null;
}
