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
  title: "PixelForge AI",
  description:
    "Pixel art studio: layers, frames and clips with multi-layer editing, onion skin, part-based motion composer, AI sprite generation, and an MCP agent console.",
  keywords: ["PixelForge AI", "pixel art", "sprite editor", "animation", "motion presets", "AI sprite generation", "sprite sheet", "GIF export"],
  authors: [{ name: "PixelForge AI" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "PixelForge AI",
    description: "Pixel art studio with layers, onion skin, motion composer, AI generation and an agent console",
    siteName: "PixelForge AI",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "PixelForge AI",
    description: "Pixel art studio with layers, onion skin, motion composer, AI generation and an agent console",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
