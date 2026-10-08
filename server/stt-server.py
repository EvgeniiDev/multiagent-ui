#!/usr/bin/env python3
"""GigaAM speech-to-text service for the panel (local only, no cloud).

Why a service and not a CLI: loading the checkpoint costs ~4.2 s (measured), while
transcribing costs 0.25 s for 2 s of audio and 0.34 s for 4 s (RTF 0.085–0.124 on
CPU) — so one resident model serves thousands of windows.

GigaAM v3_e2e_rnnt is not a streaming model. The stream endpoint decodes
bounded phrases and commits them at pauses:

  * the client pushes raw PCM16 mono @16 kHz over the websocket;
  * every HOP_S the current phrase is decoded as a volatile hypothesis;
  * after 0.8 s of silence the phrase is finalised and appended to committed text;
  * phrases are bounded to 20 s; on stop only the outstanding phrase is decoded.
    Previously committed phrases are never replaced by a later window or final.

Endpoints
  GET  /health                     -> {ok, model, device, window_s, hop_s}
  POST /transcribe  (audio bytes)  -> {text, seconds}      (any ffmpeg-readable format)
  WS   /ws/stream                  <- PCM16 frames, -> {type: partial|final|error, ...}

Bind: 0.0.0.0:$PORT (default 25905) so the LAN browser client can reach it, the
same trust model as the ACP bridges — an LAN service with no auth, not exposed.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from stt_stream import PcmUtterances

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("stt")

MODEL_NAME = os.environ.get("STT_MODEL", "v3_e2e_rnnt")
PORT = int(os.environ.get("PORT", "25905"))
HOST = os.environ.get("HOST", "0.0.0.0")

SAMPLE_RATE = 16000          # GigaAM is trained at 16 kHz mono
HOP_S = float(os.environ.get("STT_HOP_S", "1"))           # how often a partial is produced
MIN_PARTIAL_S = 1.0          # don't decode before this much audio arrived
LONGFORM_THRESHOLD_S = 24.0  # above this, transcribe_longform (VAD-segmented)

_MODEL = None
_LOAD_LOCK = threading.Lock()
_INFER_LOCK = threading.Lock()   # one model, one inference at a time
_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stt")
_LOADED_AT: float | None = None


def get_model():
    """Load the checkpoint once, on first use, and keep it resident."""
    global _MODEL, _LOADED_AT
    if _MODEL is None:
        with _LOAD_LOCK:
            if _MODEL is None:
                started = time.time()
                import gigaam  # heavy import (torch), keep it inside the loader

                _MODEL = gigaam.load_model(MODEL_NAME)
                _LOADED_AT = time.time()
                log.info("model %s loaded in %.2fs", MODEL_NAME, _LOADED_AT - started)
    return _MODEL


def pcm16_to_wav(pcm: bytes, path: str, sample_rate: int = SAMPLE_RATE) -> str:
    """Wrap raw little-endian PCM16 mono into a WAV file GigaAM can read."""
    with wave.open(path, "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(sample_rate)
        fh.writeframes(pcm)
    return path


def any_to_pcm16_wav(src_bytes: bytes, path: str, sample_rate: int = SAMPLE_RATE) -> str:
    """Convert an uploaded audio blob (ogg/mp3/webm/...) to 16 kHz mono PCM16 WAV."""
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as raw:
        raw.write(src_bytes)
        raw_path = raw.name
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", raw_path, "-ac", "1", "-ar", str(sample_rate),
             "-f", "wav", path],
            check=True, capture_output=True,
        )
    finally:
        os.unlink(raw_path)
    return path


def _text_of(result: Any) -> str:
    if isinstance(result, str):
        return result.strip()
    text = getattr(result, "text", None)
    if isinstance(text, str):
        return text.strip()
    segments = getattr(result, "segments", None) or []
    parts = [s.text.strip() for s in segments if getattr(s, "text", None)]
    return " ".join(parts).strip() if parts else str(result).strip()


def transcribe_wav(path: str) -> str:
    """Decode one WAV file. Long audio goes through the VAD-segmented longform path."""
    model = get_model()
    seconds = wav_seconds(path)
    with _INFER_LOCK:
        if seconds > LONGFORM_THRESHOLD_S:
            try:
                return _text_of(model.transcribe_longform(path))
            except (RuntimeError, OSError, ImportError):
                # Offline host: no local pyannote segmentation model and no
                # HF_TOKEN to fetch it — decode in plain <=20 s pieces instead
                # of failing the whole take with {"type": "error"}.
                log.warning("longform VAD unavailable, falling back to chunked decode")
                return _transcribe_chunked(model, path)
        return _text_of(model.transcribe(path))


def _transcribe_chunked(model: Any, path: str, chunk_s: float = 20.0) -> str:
    """Plain decode in <=chunk_s pieces (fallback when longform VAD is missing)."""
    with wave.open(path, "rb") as fh:
        channels, width, rate = fh.getnchannels(), fh.getsampwidth(), fh.getframerate()
        frames = fh.readframes(fh.getnframes())
    stride = int(chunk_s * rate) * width * channels
    parts: list[str] = []
    with tempfile.TemporaryDirectory(prefix="stt-chunks-") as tmp:
        for i, off in enumerate(range(0, max(len(frames), 1), stride)):
            cp = os.path.join(tmp, f"c{i}.wav")
            with wave.open(cp, "wb") as fh:
                fh.setnchannels(channels)
                fh.setsampwidth(width)
                fh.setframerate(rate)
                fh.writeframes(frames[off:off + stride])
            parts.append(_text_of(model.transcribe(cp)))
    return " ".join(p for p in parts if p).strip()


def wav_seconds(path: str) -> float:
    with wave.open(path, "rb") as fh:
        frames, rate = fh.getnframes(), fh.getframerate()
    return frames / float(rate or 1)


# --------------------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------------------

from contextlib import asynccontextmanager  # noqa: E402

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Load the model at boot so the first utterance doesn't eat the 4 s stall.

    STT_NO_WARMUP=1 keeps the import cheap for a syntax/route check.
    """
    if os.environ.get("STT_NO_WARMUP") != "1":
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(_POOL, get_model)
    yield


app = FastAPI(title="GigaAM STT", version="1.0.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "model": MODEL_NAME,
        "loaded": _MODEL is not None,
        "loaded_at": _LOADED_AT,
        "sample_rate": SAMPLE_RATE,
        "window_s": 20.0,  # legacy health field: maximum phrase length
        "segmentation": "pause",
        "pause_s": 0.8,
        "hop_s": HOP_S,
    }


@app.post("/transcribe")
async def transcribe(request: Request) -> JSONResponse:
    """One-shot: any audio blob in, final text out (fallback for old clients)."""
    body = await request.body()
    if not body:
        return JSONResponse({"error": "empty body"}, status_code=400)
    loop = asyncio.get_running_loop()

    def run() -> dict:
        with tempfile.TemporaryDirectory(prefix="stt-one-shot-") as tmp:
            wav = any_to_pcm16_wav(body, os.path.join(tmp, "a.wav"))
            return {"text": transcribe_wav(wav), "seconds": round(wav_seconds(wav), 2)}

    try:
        return JSONResponse(await loop.run_in_executor(_POOL, run))
    except Exception as exc:  # noqa: BLE001 — surface the real reason to the client
        log.exception("transcribe failed")
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket) -> None:
    await ws.accept()
    loop = asyncio.get_running_loop()
    audio = PcmUtterances()
    committed_parts: list[str] = []
    volatile = ""
    last_partial_bytes = 0
    started = time.time()
    disconnected = False
    log.info("stream client connected")

    async def decode(pcm: bytes) -> str:
        def run() -> str:
            with tempfile.TemporaryDirectory(prefix="stt-phrase-") as tmp:
                path = pcm16_to_wav(pcm, os.path.join(tmp, "p.wav"))
                return transcribe_wav(path)
        return await loop.run_in_executor(_POOL, run)

    async def emit_partial() -> None:
        settled = " ".join(committed_parts)
        await ws.send_text(json.dumps({
            "type": "partial", "committed": settled, "volatile": volatile,
            "text": " ".join(p for p in (settled, volatile) if p),
            "audio_s": round(audio.received_bytes / (SAMPLE_RATE * 2), 2),
            "took_s": None, "since_start_s": round(time.time() - started, 2),
        }, ensure_ascii=False))

    wake = asyncio.Event()
    stopping = False

    async def receive_audio() -> None:
        nonlocal audio, stopping, disconnected, volatile, started
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                disconnected = True
                return
            if (data := message.get("bytes")) is not None:
                audio.push(data)
                wake.set()
                continue
            if (text := message.get("text")) is not None:
                try:
                    control = json.loads(text)
                except ValueError:
                    continue
                if control.get("type") == "stop":
                    audio.finish()
                    stopping = True
                    wake.set()
                    return
                if control.get("type") == "reset":
                    audio = PcmUtterances()
                    committed_parts.clear()
                    volatile = ""
                    started = time.time()
                    wake.set()

    async def recognise() -> None:
        nonlocal volatile, last_partial_bytes
        previous_audio = None
        while True:
            await wake.wait()
            wake.clear()
            current = audio
            if current is not previous_audio:
                last_partial_bytes = 0
                previous_audio = current
            changed = False
            while current.completed:
                text = await decode(current.completed.popleft())
                if current is not audio:
                    break  # reset occurred while the worker was decoding
                if text:
                    committed_parts.append(text)
                volatile = ""
                last_partial_bytes = 0
                changed = True
            if current is not audio:
                continue
            if stopping:
                text = " ".join(committed_parts)
                await ws.send_text(json.dumps({
                    "type": "final", "text": text, "committed": text, "volatile": "",
                    "audio_s": round(current.received_bytes / (SAMPLE_RATE * 2), 2),
                    "total_s": round(time.time() - started, 2),
                }, ensure_ascii=False))
                return
            size = len(current.active)
            if (size >= MIN_PARTIAL_S * SAMPLE_RATE * 2
                    and size - last_partial_bytes >= HOP_S * SAMPLE_RATE * 2):
                sequence = current.sequence
                last_partial_bytes = size
                hypothesis = await decode(bytes(current.active))
                # The audio reader keeps running during inference. A hypothesis
                # from before a pause/reset must not replace the next phrase.
                if current is audio and sequence == current.sequence and not stopping:
                    volatile = hypothesis
                    changed = True
            if changed and current is audio and not stopping:
                await emit_partial()
            # Incoming packets set wake while inference runs. One event means
            # one latest snapshot: never queue all the obsolete partial passes.

    reader = asyncio.create_task(receive_audio())
    worker = asyncio.create_task(recognise())
    try:
        await asyncio.wait({reader, worker}, return_when=asyncio.FIRST_COMPLETED)
        if worker.done():
            await worker  # surface a decoding error instead of waiting for input
        else:
            await reader
            if not disconnected:
                await worker
    except WebSocketDisconnect:
        disconnected = True
    except Exception as exc:
        log.exception("stream decode failed")
        try:
            await ws.send_text(json.dumps({"type": "error", "error": str(exc)}))
        except Exception:
            disconnected = True
    finally:
        for task in (reader, worker):
            if not task.done():
                task.cancel()
        await asyncio.gather(reader, worker, return_exceptions=True)
        if not disconnected:
            try:
                await ws.close()
            except Exception:
                pass
        log.info("stream client done (%.1fs of audio)", audio.received_bytes / (SAMPLE_RATE * 2))


def main() -> int:
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info", ws_ping_interval=20)
    return 0


if __name__ == "__main__":
    sys.exit(main())
