import { NextResponse } from "next/server";

const TTS_SERVER_URL = "http://127.0.0.1:8765";

export async function GET() {
  const response = await fetch(`${TTS_SERVER_URL}/voices`, {
    cache: "no-store",
  });

  if (!response.ok) {
    return NextResponse.json({
      voices: [],
    });
  }

  const { voices } = (await response.json()) as {
    voices: string[];
  };

  return NextResponse.json({
    voices: voices.map((voice) => ({
      name: voice,
      label: voice.replace(/\.wav$/, ""),
    })),
  });
}
