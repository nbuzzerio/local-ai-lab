from datetime import datetime, timezone
from pathlib import Path
from queue import Queue
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
CHUNK_SILENCE_SECONDS = 0.25

app = FastAPI()
jobs = {}
job_queue: Queue[tuple[str, "SpeakRequest"]] = Queue()

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


def is_valid_voice_name(voice: str) -> bool:
    return voice.endswith(".wav") and "/" not in voice and "\\" not in voice


def list_voices() -> list[str]:
    VOICES_DIR.mkdir(parents=True, exist_ok=True)

    return sorted(
        [file.name for file in VOICES_DIR.glob("*.wav")],
        key=str.lower,
    )


def split_into_sentences(text: str) -> list[str]:
    return (
        re.findall(r'[^.!?]+[.!?]+["\')\]]*|[^.!?]+$', text.replace("\n", " ").strip())
        or []
    )


def split_text_into_chunks(text: str, max_chars: int = 220) -> list[list[str]]:
    sentences = [sentence.strip() for sentence in split_into_sentences(text) if sentence.strip()]
    chunks: list[list[str]] = []
    current: list[str] = []
    current_length = 0

    for sentence in sentences:
        if len(sentence) > max_chars:
            if current:
                chunks.append(current)
                current = []
                current_length = 0

            words = sentence.split()
            part = ""

            for word in words:
                if len(part) + len(word) + 1 > max_chars:
                    chunks.append([part.strip()])
                    part = word
                else:
                    part = f"{part} {word}".strip()

            if part:
                chunks.append([part.strip()])

            continue

        next_length = current_length + len(sentence) + (1 if current else 0)

        if next_length <= max_chars:
            current.append(sentence)
            current_length = next_length
        else:
            chunks.append(current)
            current = [sentence]
            current_length = len(sentence)

    if current:
        chunks.append(current)

    return chunks


def create_sentence_segments(
    *,
    chunk_sentences: list[str],
    chunk_start: float,
    chunk_duration: float,
) -> list[dict]:
    total_weight = sum(max(len(sentence), 1) for sentence in chunk_sentences)

    if total_weight <= 0 or chunk_duration <= 0:
        return []

    cursor = chunk_start
    segments = []

    for index, sentence in enumerate(chunk_sentences):
        is_last = index == len(chunk_sentences) - 1
        weight = max(len(sentence), 1)
        sentence_duration = (
            chunk_start + chunk_duration - cursor
            if is_last
            else (weight / total_weight) * chunk_duration
        )

        start = cursor
        end = chunk_start + chunk_duration if is_last else cursor + sentence_duration

        segments.append(
            {
                "text": sentence,
                "start": round(start, 3),
                "end": round(end, 3),
            }
        )

        cursor = end

    return segments


def write_metadata(
    metadata_path: Path,
    *,
    title: str,
    text: str,
    voice: str,
    language: str,
    output_name: str,
    segments: list[dict],
):
    metadata = {
        "title": title,
        "text": text,
        "voice": voice,
        "language": language,
        "audioFile": output_name,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "segments": segments,
    }

    metadata_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def generate_job(job_id: str, payload: SpeakRequest):
    try:
        OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

        if jobs[job_id]["status"] == "cancelled":
            return

        if not is_valid_voice_name(payload.voice):
            raise ValueError("Invalid voice file name.")

        voice_path = VOICES_DIR / payload.voice

        if not voice_path.exists():
            raise ValueError(f"Voice not found: {payload.voice}")

        chunks = split_text_into_chunks(payload.text)
        output_name = f"{slugify(payload.title)}-{uuid4().hex[:8]}.wav"
        metadata_name = output_name.replace(".wav", ".json")
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
        segments = []
        audio_cursor = 0.0

        for index, chunk_sentences in enumerate(chunks, start=1):
            if jobs[job_id]["status"] == "cancelled":
                return

            chunk_text = " ".join(chunk_sentences)

            print(f"Generating chunk {index}/{len(chunks)}...")

            out = model.inference(
                chunk_text,
                payload.language,
                gpt_cond_latent,
                speaker_embedding,
            )

            chunk_wav = torch.tensor(out["wav"])
            chunk_duration = len(chunk_wav) / SAMPLE_RATE

            wav_chunks.append(chunk_wav)

            segments.extend(
                create_sentence_segments(
                    chunk_sentences=chunk_sentences,
                    chunk_start=audio_cursor,
                    chunk_duration=chunk_duration,
                )
            )

            audio_cursor += chunk_duration

            if index < len(chunks):
                silence = torch.zeros(int(SAMPLE_RATE * CHUNK_SILENCE_SECONDS))
                wav_chunks.append(silence)
                audio_cursor += CHUNK_SILENCE_SECONDS

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
            segments=segments,
        )

        jobs[job_id]["status"] = "complete"

    except Exception as error:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(error)


def job_worker():
    while True:
        job_id, payload = job_queue.get()

        try:
            if jobs[job_id]["status"] != "cancelled":
                generate_job(job_id, payload)
        finally:
            job_queue.task_done()


worker_thread = threading.Thread(target=job_worker, daemon=True)
worker_thread.start()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/voices")
def voices():
    return {"voices": list_voices()}


@app.post("/speak")
def speak(payload: SpeakRequest):
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="Text is required.")

    if not payload.title.strip():
        raise HTTPException(status_code=400, detail="Title is required.")

    if not is_valid_voice_name(payload.voice):
        raise HTTPException(status_code=400, detail="Invalid voice file name.")

    if payload.voice not in list_voices():
        raise HTTPException(status_code=400, detail="Voice not found.")

    job_id = uuid4().hex
    jobs[job_id] = {
        "status": "queued",
        "totalChunks": 0,
        "completedChunks": 0,
        "outputName": None,
        "metadataName": None,
        "error": None,
    }

    job_queue.put((job_id, payload))

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