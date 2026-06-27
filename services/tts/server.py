from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
import json
import re
import threading

import torch
import torchaudio
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from TTS.tts.configs.xtts_config import XttsConfig
from TTS.tts.models.xtts import Xtts

BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "models" / "xtts_v2"
VOICES_DIR = BASE_DIR / "voices"
OUTPUTS_DIR = BASE_DIR / "outputs"
SAMPLE_RATE = 24000

app = FastAPI()
jobs = {}

print("Loading XTTS config...")
config = XttsConfig()
config.load_json(str(MODEL_DIR / "config.json"))

print("Loading XTTS model...")
model = Xtts.init_from_config(config)
model.load_checkpoint(config, checkpoint_dir=str(MODEL_DIR), eval=True)
model.cuda()

print("XTTS ready.")


class SpeakRequest(BaseModel):
    text: str
    title: str
    voice: str = "nova.wav"
    language: str = "en"


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return slug[:60] or "untitled"


def split_text(text: str, max_chars: int = 220) -> list[str]:
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    chunks: list[str] = []
    current = ""

    for sentence in sentences:
        if not sentence:
            continue

        if len(sentence) > max_chars:
            if current:
                chunks.append(current.strip())
                current = ""

            words = sentence.split()
            part = ""

            for word in words:
                if len(part) + len(word) + 1 > max_chars:
                    chunks.append(part.strip())
                    part = word
                else:
                    part = f"{part} {word}".strip()

            if part:
                chunks.append(part.strip())

            continue

        if len(current) + len(sentence) + 1 <= max_chars:
            current = f"{current} {sentence}".strip()
        else:
            chunks.append(current.strip())
            current = sentence

    if current:
        chunks.append(current.strip())

    return chunks


def write_metadata(
    metadata_path: Path,
    *,
    title: str,
    text: str,
    voice: str,
    language: str,
    output_name: str,
):
    metadata = {
        "title": title,
        "text": text,
        "voice": voice,
        "language": language,
        "audioFile": output_name,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }

    metadata_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def generate_job(job_id: str, payload: SpeakRequest):
    try:
        OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

        chunks = split_text(payload.text)
        output_name = f"{slugify(payload.title)}-{uuid4().hex[:8]}.wav"
        metadata_name = output_name.replace(".wav", ".json")
        voice_path = VOICES_DIR / payload.voice
        output_path = OUTPUTS_DIR / output_name
        metadata_path = OUTPUTS_DIR / metadata_name

        jobs[job_id].update(
            {
                "status": "running",
                "totalChunks": len(chunks),
                "completedChunks": 0,
                "outputName": output_name,
                "metadataName": metadata_name,
                "error": None,
            }
        )

        gpt_cond_latent, speaker_embedding = model.get_conditioning_latents(
            audio_path=str(voice_path)
        )

        wav_chunks = []

        for index, chunk in enumerate(chunks, start=1):
            if jobs[job_id]["status"] == "cancelled":
                return

            print(f"Generating chunk {index}/{len(chunks)}...")

            out = model.inference(
                chunk,
                payload.language,
                gpt_cond_latent,
                speaker_embedding,
            )

            wav_chunks.append(torch.tensor(out["wav"]))

            if index < len(chunks):
                wav_chunks.append(torch.zeros(int(SAMPLE_RATE * 0.25)))

            jobs[job_id]["completedChunks"] = index

        if jobs[job_id]["status"] == "cancelled":
            return

        final_wav = torch.cat(wav_chunks).unsqueeze(0)

        torchaudio.save(
            str(output_path),
            final_wav,
            SAMPLE_RATE,
        )

        write_metadata(
            metadata_path,
            title=payload.title,
            text=payload.text,
            voice=payload.voice,
            language=payload.language,
            output_name=output_name,
        )

        jobs[job_id]["status"] = "complete"

    except Exception as error:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(error)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/speak")
def speak(payload: SpeakRequest):
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="Text is required.")

    if not payload.title.strip():
        raise HTTPException(status_code=400, detail="Title is required.")

    job_id = uuid4().hex
    jobs[job_id] = {
        "status": "queued",
        "totalChunks": 0,
        "completedChunks": 0,
        "outputName": None,
        "metadataName": None,
        "error": None,
    }

    thread = threading.Thread(target=generate_job, args=(job_id, payload), daemon=True)
    thread.start()

    return {"jobId": job_id}


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found.")

    return jobs[job_id]


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found.")

    jobs[job_id]["status"] = "cancelled"
    return jobs[job_id]


@app.get("/clips")
def clips():
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

    files = sorted(
        [file.name for file in OUTPUTS_DIR.glob("*.wav")],
        reverse=True,
    )

    return {"clips": files}