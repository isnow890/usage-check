import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Usage Check",
  description: "Codex, Claude, Antigravity, OpenCode and CommandCode usage in one place.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
