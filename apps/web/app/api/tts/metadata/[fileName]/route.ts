import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

type Params = {
  params: Promise<{
    fileName: string;
  }>;
};

function isValidMetadataFileName(fileName: string) {
  return (
    fileName.endsWith(".json") &&
    !fileName.includes("/") &&
    !fileName.includes("\\")
  );
}

export async function GET(_request: Request, { params }: Params) {
  const { fileName } = await params;

  if (!isValidMetadataFileName(fileName)) {
    return NextResponse.json(
      { error: "Invalid metadata file name." },
      { status: 400 },
    );
  }

  const repoRoot = path.resolve(process.cwd(), "../..");
  const filePath = path.join(repoRoot, "services", "tts", "outputs", fileName);

  try {
    const metadata = await fs.readFile(filePath, "utf-8");

    return new Response(metadata, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Metadata file not found." },
      { status: 404 },
    );
  }
}
