import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Football Match Live Tracker",
  description: "Every player and the ball in 3D, in real time, from real tracking data.",
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        <div id="root-shell">{children}</div>
      </body>
    </html>
  );
}
