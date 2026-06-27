"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_TEXT =
  "Hello Nick. This is your local AI lab reading pasted text with a cloned voice.";

const FONT_SIZE_CLASSES = {
  base: "text-base",
  lg: "text-lg",
  xl: "text-xl",
  "2xl": "text-2xl",
  "3xl": "text-3xl",
} as const;

type FontSize = keyof typeof FONT_SIZE_CLASSES;

type Clip = {
  name: string;
  url: string;
  metadataUrl: string;
};

type JobStatus = {
  status: "queued" | "running" | "complete" | "error" | "cancelled";
  totalChunks: number;
  completedChunks: number;
  outputName: string | null;
  metadataName: string | null;
  audioUrl?: string | null;
  metadataUrl?: string | null;
  error: string | null;
};

type ClipMetadata = {
  title: string;
  text: string;
  voice: string;
  language: string;
  audioFile: string;
  createdAt: string;
};

type SentenceTiming = {
  sentence: string;
  start: number;
  end: number;
};

function formatClipName(fileName: string) {
  return fileName
    .replace(/-[a-f0-9]{8}\.wav$/, "")
    .replace(/\.wav$/, "")
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes === 0) {
    return `${remainingSeconds}s remaining`;
  }

  return `${minutes}m ${remainingSeconds}s remaining`;
}

function splitIntoSentences(value: string) {
  return (
    value
      .replace(/\s+/g, " ")
      .trim()
      .match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean) ?? []
  );
}

function buildEstimatedSentenceTimings(
  sentences: string[],
  duration: number,
): SentenceTiming[] {
  if (duration <= 0 || sentences.length === 0) {
    return [];
  }

  const totalWeight = sentences.reduce(
    (sum, sentence) => sum + Math.max(sentence.length, 1),
    0,
  );

  let cursor = 0;

  return sentences.map((sentence, index) => {
    const isLast = index === sentences.length - 1;
    const weight = Math.max(sentence.length, 1);
    const sentenceDuration = isLast
      ? duration - cursor
      : (weight / totalWeight) * duration;

    const timing = {
      sentence,
      start: cursor,
      end: isLast ? duration : cursor + sentenceDuration,
    };

    cursor = timing.end;

    return timing;
  });
}

export default function Home() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const pollIntervalRef = useRef<number | null>(null);

  const [title, setTitle] = useState("");
  const [text, setText] = useState(DEFAULT_TEXT);
  const [readerText, setReaderText] = useState(DEFAULT_TEXT);
  const [audioUrl, setAudioUrl] = useState("");
  const [speed, setSpeed] = useState(2);
  const [fontSize, setFontSize] = useState<FontSize>("xl");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<JobStatus | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [error, setError] = useState("");
  const [currentJobId, setCurrentJobId] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const sentences = useMemo(() => splitIntoSentences(readerText), [readerText]);

  const sentenceTimings = useMemo(
    () => buildEstimatedSentenceTimings(sentences, duration),
    [sentences, duration],
  );

  const activeSentenceIndex = sentenceTimings.findIndex(
    (timing) => currentTime >= timing.start && currentTime < timing.end,
  );

  async function loadClips() {
    const response = await fetch("/api/tts/clips");
    const data = (await response.json()) as { clips: Clip[] };
    setClips(data.clips);
  }

  async function loadMetadata(metadataUrl: string) {
    try {
      const response = await fetch(metadataUrl, { cache: "no-store" });

      if (!response.ok) {
        throw new Error("Metadata not found.");
      }

      const metadata = (await response.json()) as ClipMetadata;

      setReaderText(metadata.text);
    } catch {
      setReaderText(
        "No saved transcript metadata was found for this clip. Generate it again to create read-along metadata.",
      );
    }
  }

  useEffect(() => {
    const savedSpeed = window.localStorage.getItem("tts-playback-speed");
    const savedFontSize = window.localStorage.getItem("tts-reader-font-size");

    if (savedSpeed) {
      setSpeed(Number(savedSpeed));
    }

    if (
      savedFontSize &&
      Object.keys(FONT_SIZE_CLASSES).includes(savedFontSize)
    ) {
      setFontSize(savedFontSize as FontSize);
    }

    void loadClips();

    return () => {
      if (pollIntervalRef.current) {
        window.clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  async function generateSpeech() {
    setIsGenerating(true);
    setError("");
    setProgress(null);
    setStartedAt(Date.now());
    setReaderText(text);
    setCurrentTime(0);
    setDuration(0);

    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, title }),
      });

      const data = (await response.json()) as {
        jobId?: string;
        error?: string;
      };

      if (!response.ok || !data.jobId) {
        throw new Error(data.error ?? "Failed to start generation.");
      }

      setCurrentJobId(data.jobId);
      pollJob(data.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setIsGenerating(false);
    }
  }

  function pollJob(jobId: string) {
    if (pollIntervalRef.current) {
      window.clearInterval(pollIntervalRef.current);
    }

    pollIntervalRef.current = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/tts/jobs/${jobId}`);
        const data = (await response.json()) as JobStatus;

        setProgress(data);

        if (data.status === "complete" && data.audioUrl) {
          if (pollIntervalRef.current) {
            window.clearInterval(pollIntervalRef.current);
          }

          setAudioUrl(data.audioUrl);
          setIsGenerating(false);
          setCurrentJobId("");

          if (data.metadataUrl) {
            await loadMetadata(data.metadataUrl);
          }

          await loadClips();

          setTimeout(() => {
            if (audioRef.current) {
              audioRef.current.load();
              audioRef.current.playbackRate = speed;
              void audioRef.current.play();
            }
          }, 100);
        }

        if (data.status === "cancelled") {
          if (pollIntervalRef.current) {
            window.clearInterval(pollIntervalRef.current);
          }

          setIsGenerating(false);
          setCurrentJobId("");
        }

        if (data.status === "error") {
          if (pollIntervalRef.current) {
            window.clearInterval(pollIntervalRef.current);
          }

          throw new Error(data.error ?? "Generation failed.");
        }
      } catch (err) {
        if (pollIntervalRef.current) {
          window.clearInterval(pollIntervalRef.current);
        }

        setError(err instanceof Error ? err.message : "Something went wrong.");
        setIsGenerating(false);
        setCurrentJobId("");
      }
    }, 1000);
  }

  async function cancelGeneration() {
    if (!currentJobId) return;

    await fetch(`/api/tts/jobs/${currentJobId}/cancel`, {
      method: "POST",
    });

    if (pollIntervalRef.current) {
      window.clearInterval(pollIntervalRef.current);
    }

    setIsGenerating(false);
    setCurrentJobId("");
    setProgress((current) =>
      current ? { ...current, status: "cancelled" } : current,
    );
  }

  function skip(seconds: number) {
    if (!audioRef.current) return;

    audioRef.current.currentTime = Math.min(
      audioRef.current.duration,
      Math.max(0, audioRef.current.currentTime + seconds),
    );
  }

  function updateSpeed(nextSpeed: number) {
    setSpeed(nextSpeed);
    window.localStorage.setItem("tts-playback-speed", String(nextSpeed));

    if (audioRef.current) {
      audioRef.current.playbackRate = nextSpeed;
    }
  }

  function updateFontSize(nextFontSize: FontSize) {
    setFontSize(nextFontSize);
    window.localStorage.setItem("tts-reader-font-size", nextFontSize);
  }

  function selectClip(selectedAudioUrl: string) {
    const selectedClip = clips.find((clip) => clip.url === selectedAudioUrl);

    setAudioUrl(selectedAudioUrl);
    setCurrentTime(0);
    setDuration(0);

    if (selectedClip) {
      void loadMetadata(selectedClip.metadataUrl);
    }

    setTimeout(() => {
      if (audioRef.current) {
        audioRef.current.load();
        audioRef.current.playbackRate = speed;
      }
    }, 100);
  }

  const progressValue =
    progress && progress.totalChunks > 0
      ? Math.round((progress.completedChunks / progress.totalChunks) * 100)
      : 0;

  const estimatedSecondsRemaining =
    startedAt && progress && progress.completedChunks > 0
      ? Math.round(
          ((Date.now() - startedAt) / 1000 / progress.completedChunks) *
            (progress.totalChunks - progress.completedChunks),
        )
      : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-3xl font-bold">Local AI Lab</h1>
        <p className="mt-2 text-sm opacity-70">
          Paste text, generate speech locally, and play it back.
        </p>
      </header>

      <section className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="font-medium">Title</span>
            <input
              className="rounded-lg border bg-black p-3 text-white disabled:opacity-60"
              disabled={isGenerating}
              placeholder="Example: House Drakan Foreword"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="font-medium">Text</span>
            <textarea
              className="min-h-96 w-full rounded-lg border bg-black p-4 text-base text-white disabled:opacity-60"
              disabled={isGenerating}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            {isGenerating ? (
              <button
                className="rounded-lg border border-red-500 px-4 py-2 text-red-500"
                onClick={cancelGeneration}
              >
                Cancel
              </button>
            ) : (
              <button
                className="rounded-lg bg-black px-4 py-2 text-white disabled:opacity-50"
                disabled={!text.trim() || !title.trim()}
                onClick={generateSpeech}
              >
                Generate & Play
              </button>
            )}

            <label className="flex items-center gap-2">
              Speed
              <select
                className="rounded border bg-black px-2 py-1 text-white"
                value={speed}
                onChange={(event) => updateSpeed(Number(event.target.value))}
              >
                {[0.75, 1, 1.25, 1.5, 2, 2.5, 3].map((value) => (
                  <option key={value} value={value}>
                    {value}x
                  </option>
                ))}
              </select>
            </label>
          </div>

          {progress ? (
            <section className="rounded-lg border p-4">
              <p className="mb-2 text-sm">
                {progress.status === "queued"
                  ? "Queued..."
                  : progress.status === "cancelled"
                    ? "Cancelled"
                    : `Generating chunk ${progress.completedChunks} / ${progress.totalChunks}`}
              </p>

              <progress className="w-full" max={100} value={progressValue} />

              <div className="mt-2 flex justify-between text-sm opacity-70">
                <span>{progressValue}%</span>
                <span>
                  {estimatedSecondsRemaining === null
                    ? "Estimating..."
                    : formatTime(estimatedSecondsRemaining)}
                </span>
              </div>
            </section>
          ) : null}
        </div>

        <aside className="flex flex-col gap-4 rounded-lg border p-4">
          <h2 className="text-xl font-semibold">Saved clips</h2>

          <select
            className="rounded border bg-black p-2 text-white"
            value={audioUrl}
            onChange={(event) => selectClip(event.target.value)}
          >
            <option value="">Choose a generated clip</option>
            {clips.map((clip) => (
              <option key={clip.name} value={clip.url}>
                {formatClipName(clip.name)}
              </option>
            ))}
          </select>

          <button className="rounded border px-3 py-2" onClick={loadClips}>
            Refresh clips
          </button>
        </aside>
      </section>

      {audioUrl ? (
        <section className="flex flex-col gap-4 rounded-lg border p-4">
          <audio
            ref={audioRef}
            controls
            preload="metadata"
            onDurationChange={(event) =>
              setDuration(event.currentTarget.duration || 0)
            }
            onLoadedMetadata={(event) =>
              setDuration(event.currentTarget.duration || 0)
            }
            onTimeUpdate={(event) =>
              setCurrentTime(event.currentTarget.currentTime)
            }
          >
            <source src={audioUrl} type="audio/wav" />
          </audio>

          <div className="flex flex-wrap gap-2">
            {[-60, -30, -20, -10, 10, 20, 30, 60].map((seconds) => (
              <button
                className="rounded border px-3 py-1"
                key={seconds}
                onClick={() => skip(seconds)}
              >
                {seconds > 0 ? `+${seconds}s` : `${seconds}s`}
              </button>
            ))}
          </div>

          <section className="rounded-lg border p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">Read along</h2>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm opacity-70">Text size</span>
                {(Object.keys(FONT_SIZE_CLASSES) as FontSize[]).map((size) => (
                  <button
                    className={`rounded border px-2 py-1 ${
                      fontSize === size ? "bg-black text-white" : ""
                    }`}
                    key={size}
                    onClick={() => updateFontSize(size)}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>

            <div
              className={`max-h-[32rem] overflow-y-auto rounded-lg bg-neutral-950 p-5 leading-relaxed text-white ${FONT_SIZE_CLASSES[fontSize]}`}
            >
              {sentenceTimings.length > 0 ? (
                sentenceTimings.map((timing, index) => (
                  <span
                    className={
                      index === activeSentenceIndex
                        ? "rounded bg-yellow-300 px-1 text-black"
                        : "opacity-75"
                    }
                    key={`${timing.start}-${timing.sentence}`}
                  >
                    {timing.sentence}{" "}
                  </span>
                ))
              ) : (
                <p className="opacity-75">{readerText}</p>
              )}
            </div>

            <p className="mt-3 text-sm opacity-60">
              Highlighting is estimated from saved source text and audio
              duration.
            </p>
          </section>
        </section>
      ) : null}

      {error ? <p className="text-red-600">{error}</p> : null}
    </main>
  );
}
