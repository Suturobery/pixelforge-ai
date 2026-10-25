import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PixelForge AI — Motion Lab",
  description: "Pixel art editor with part-based motion composer: five animation presets, heuristic motion QA, and sprite sheet / GIF export.",
  keywords: ["PixelForge AI", "pixel art", "sprite animation", "motion presets", "pixel editor", "sprite sheet", "GIF export"],
  authors: [{ name: "PixelForge AI" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "PixelForge AI — Motion Lab",
    description: "Pixel art editor with part-based motion composer and animation presets",
    siteName: "PixelForge AI",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "PixelForge AI — Motion Lab",
    description: "Pixel art editor with part-based motion composer and animation presets",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
