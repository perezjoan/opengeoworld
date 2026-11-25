import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "opengeoworld · world",
  description:
    "Walk and fly around a real place built from open data.",
};

// Where the engine's built-in assets (avatar, animations, font, textures, decoders) are served:
// the engine reads it once, when it loads, so it must be set before any game code runs.
const ENGINE_ASSETS_BASE = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/engine-assets`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: `window.$engineAssetsBase=${JSON.stringify(ENGINE_ASSETS_BASE)};` }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
