import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Football Match Replay",
  description: "3D replay of a football match driven by real tracking data.",
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
