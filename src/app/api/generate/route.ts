import { NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * PixelForge AI — sprite generation endpoint (backend only; SDK never ships to client).
 * POST { prompt: string } -> { image: base64 png }
 *
 * The raw 1024x1024 AI output is returned; normalization to a crisp
 * PixelGrid (downscale + quantize + alpha threshold) happens client-side
 * in src/lib/pixelforge/normalize.ts so users can tweak and re-apply.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { prompt } = (body ?? {}) as { prompt?: unknown };
  if (typeof prompt !== "string" || prompt.trim().length < 3) {
    return NextResponse.json(
      { error: "Prompt must be a string with at least 3 characters." },
      { status: 400 }
    );
  }
  if (prompt.length > 600) {
    return NextResponse.json(
      { error: "Prompt too long (max 600 characters)." },
      { status: 400 }
    );
  }

  // Pixel-art oriented prompt augmentation: flat colors, clean silhouette,
  // single centered subject on a plain background -> best normalization input.
  const augmented = [
    prompt.trim(),
    "pixel art sprite",
    "16-bit retro game asset style",
    "flat solid colors, limited palette, clean sharp pixels",
    "single centered character, full body visible",
    "plain white background, no text, no watermark, no border",
  ].join(", ");

  try {
    const zai = await ZAI.create();
    const response = await zai.images.generations.create({
      prompt: augmented,
      size: "1024x1024",
    });

    const base64 = response?.data?.[0]?.base64;
    if (!base64) {
      return NextResponse.json(
        { error: "Image generation returned no data. Try again." },
        { status: 502 }
      );
    }

    return NextResponse.json({ image: base64, source: "zai-image-gen" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown generation error";
    return NextResponse.json({ error: `Generation failed: ${message}` }, { status: 502 });
  }
}
