import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Covered. — Sports prop research",
  description: "A personal, data-driven sports prop research workspace.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
