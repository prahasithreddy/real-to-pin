import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Japan Reel-to-Map — MVP",
  description: "Paste an Instagram Reel or YouTube Short URL → pin the Japan location on a map.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
