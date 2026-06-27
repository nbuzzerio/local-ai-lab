import { NextResponse } from "next/server";

const TTS_SERVER_URL = "http://127.0.0.1:8765";

type Params = {
  params: Promise<{
    jobId: string;
  }>;
};

export async function GET(_request: Request, { params }: Params) {
  const { jobId } = await params;

  const response = await fetch(`${TTS_SERVER_URL}/jobs/${jobId}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  const job = (await response.json()) as {
    status: "queued" | "running" | "complete" | "error" | "cancelled";
    totalChunks: number;
    completedChunks: number;
    outputName: string | null;
    metadataName: string | null;
    error: string | null;
  };

  return NextResponse.json({
    ...job,
    audioUrl:
      job.status === "complete" && job.outputName
        ? `/api/tts/audio/${job.outputName}`
        : null,
    metadataUrl:
      job.status === "complete" && job.metadataName
        ? `/api/tts/metadata/${job.metadataName}`
        : null,
  });
}
