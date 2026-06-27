import { NextResponse } from "next/server";

const TTS_SERVER_URL = "http://127.0.0.1:8765";

export async function GET() {
  const response = await fetch(`${TTS_SERVER_URL}/clips`, {
    cache: "no-store",
  });

  if (!response.ok) {
    return NextResponse.json({ clips: [] });
  }

  const { clips } = (await response.json()) as { clips: string[] };

  return NextResponse.json({
    clips: clips.map((clip) => ({
      name: clip,
      url: `/api/tts/audio/${clip}`,
      metadataUrl: `/api/tts/metadata/${clip.replace(".wav", ".json")}`,
    })),
  });
}
