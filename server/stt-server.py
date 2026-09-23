#!/usr/bin/env python3
"""GigaAM speech-to-text service for the panel (local only, no cloud).

Why a service and not a CLI: loading the checkpoint costs ~4.2 s (measured), while
transcribing costs 0.25 s for 2 s of audio and 0.34 s for 4 s (RTF 0.085–0.124 on
CPU) — so one resident model serves thousands of windows.

GigaAM v3_e2e_rnnt is not a streaming model, so the stream endpoint is a sliding
window decoder with a stable-prefix commit:

  * the client pushes raw PCM16 mono @16 kHz over the websocket;
  * every HOP_S of new audio the server re-decodes the last WINDOW_S window and
    returns the hypothesis split into `committed` (the word prefix that has stopped
    changing between passes) and `volatile` (the tail that may still change);
  * on stop, one final pass over the whole utterance (longform above 24 s).

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

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("stt")

MODEL_NAME = os.environ.get("STT_MODEL", "v3_e2e_rnnt")
PORT = int(os.environ.get("PORT", "25905"))
HOST = os.environ.get("HOST", "0.0.0.0")

SAMPLE_RATE = 16000          # GigaAM is trained at 16 kHz mono
WINDOW_S = float(os.environ.get("STT_WINDOW_S", "6"))     # re-decoded window
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
            return _text_of(model.transcribe_longform(path))
        return _text_of(model.transcribe(path))


def wav_seconds(path: str) -> float:
    with wave.open(path, "rb") as fh:
        frames, rate = fh.getnframes(), fh.getframerate()
    return frames / float(rate or 1)


def stable_prefix(prev_committed: str, prev_hyp: str, cur: str) -> "tuple[str, str]":
    """Split `cur` into (committed, volatile), never shrinking what was committed.

    Two rules, and the second one exists because of a measured defect:
      1. the word prefix that stopped changing between hypotheses is settled text;
      2. committed text NEVER gets shorter. As the sliding window advances its start
         can land inside a word ("|Познавания речи..."), the hypothesis then loses
         its head and a plain common-prefix rule would return '' — the UI would
         erase text the user already read. In that case keep the previous committed
         text and treat the rest of the hypothesis as volatile.
    """
    a, b = prev_hyp.split(), cur.split()
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n]:
        n += 1
    candidate = " ".join(b[:n])

    if len(candidate.split()) >= len(prev_committed.split()):
        return candidate, " ".join(b[n:])

    idx = cur.find(prev_committed)
    if idx < 0:
        # The window starts inside a word: the tail is a broken decode, not a guess
        # worth showing. Keep what the user has read and offer nothing volatile.
        return prev_committed, ""
    return prev_committed, cur[idx + len(prev_committed):].strip()


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
        "window_s": WINDOW_S,
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
    buf = bytearray()            # all PCM of this utterance
    window = bytearray()         # last WINDOW_S of it
    last_partial_at = 0.0        # bytes consumed at the last partial
    prev_hyp = ""
    committed = ""
    started = time.time()
    log.info("stream client connected")

    def push(chunk: bytes) -> None:
        buf.extend(chunk)
        window.extend(chunk)
        max_bytes = int(WINDOW_S * SAMPLE_RATE * 2)
        if len(window) > max_bytes:
            del window[: len(window) - max_bytes]

    async def emit_partial() -> None:
        nonlocal prev_hyp, committed, last_partial_at
        pcm = bytes(window)
        last_partial_at = len(buf)

        def run() -> str:
            with tempfile.TemporaryDirectory(prefix="stt-win-") as tmp:
                path = pcm16_to_wav(pcm, os.path.join(tmp, "w.wav"))
                return transcribe_wav(path)

        hypo = await loop.run_in_executor(_POOL, run)
        settled, volatile = stable_prefix(committed, prev_hyp, hypo)
        prev_hyp = hypo
        committed = settled
        await ws.send_text(json.dumps({
            "type": "partial",
            "committed": settled,
            "volatile": volatile,
            "text": (settled + " " + volatile).strip(),
            "audio_s": round(len(buf) / (SAMPLE_RATE * 2), 2),
            "took_s": None,
            "since_start_s": round(time.time() - started, 2),
        }, ensure_ascii=False))

    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if (data := message.get("bytes")) is not None:
                push(data)
                pending = len(buf) - last_partial_at
                if (len(buf) >= MIN_PARTIAL_S * SAMPLE_RATE * 2
                        and pending >= HOP_S * SAMPLE_RATE * 2):
                    await emit_partial()
                continue
            if (text := message.get("text")) is not None:
                try:
                    control = json.loads(text)
                except ValueError:
                    continue
                if control.get("type") == "stop":
                    break
                if control.get("type") == "reset":
                    buf.clear(); window.clear(); prev_hyp = ""; committed = ""
                    last_partial_at = 0; started = time.time()
    except WebSocketDisconnect:
        pass

    # Final pass over the whole utterance: one decode, best quality.
    if buf:
        pcm = bytes(buf)

        def run_final() -> str:
            with tempfile.TemporaryDirectory(prefix="stt-final-") as tmp:
                path = pcm16_to_wav(pcm, os.path.join(tmp, "f.wav"))
                return transcribe_wav(path)

        try:
            text = await loop.run_in_executor(_POOL, run_final)
            await ws.send_text(json.dumps({
                "type": "final", "text": text, "committed": text, "volatile": "",
                "audio_s": round(len(buf) / (SAMPLE_RATE * 2), 2),
                "total_s": round(time.time() - started, 2),
            }, ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001
            log.exception("final pass failed")
            await ws.send_text(json.dumps({"type": "error", "error": str(exc)}))
    try:
        await ws.close()
    except Exception:  # noqa: BLE001 — the client may be gone already
        pass
    log.info("stream client done (%.1fs of audio)", len(buf) / (SAMPLE_RATE * 2))


def main() -> int:
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info", ws_ping_interval=20)
    return 0


if __name__ == "__main__":
    sys.exit(main())
