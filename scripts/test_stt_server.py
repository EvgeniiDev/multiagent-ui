"""Stream contract regressions; real server handlers, deterministic decoder."""
import ast
import asyncio
import logging
from pathlib import Path
import struct
import tempfile
import time
import unittest
import wave
from concurrent.futures import ThreadPoolExecutor
import json
import os

ROOT = Path(__file__).resolve().parents[1]

def load_server():
    tree = ast.parse((ROOT / 'server/stt-server.py').read_text())
    names = {'stable_prefix', 'pcm16_to_wav', 'wav_seconds', '_text_of',
             '_transcribe_chunked', 'transcribe_wav', 'ws_stream'}
    nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    for n in nodes:
        n.decorator_list = []
    ns = dict(asyncio=asyncio, logging=logging, os=os, tempfile=tempfile,
              time=time, wave=wave, json=json, Any=object, WebSocket=object,
              WebSocketDisconnect=type('Disconnect', (Exception,), {}),
              SAMPLE_RATE=16000, WINDOW_S=6, HOP_S=1, MIN_PARTIAL_S=1,
              LONGFORM_THRESHOLD_S=24, log=logging.getLogger('stt-test'),
              _POOL=ThreadPoolExecutor(max_workers=1), _INFER_LOCK=__import__('threading').Lock())
    # The stream implementation can import its pure PCM segmenter.
    import sys
    sys.path.insert(0, str(ROOT / 'server'))
    for n in tree.body:
        if isinstance(n, ast.ImportFrom) and n.module == 'stt_stream':
            exec(compile(ast.Module(body=[n], type_ignores=[]), '<imports>', 'exec'), ns)
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), '<server>', 'exec'), ns)
    return ns

class Socket:
    def __init__(self, frames):
        self.frames = iter([{'bytes': f} for f in frames] + [{'text': '{"type":"stop"}'}])
        self.messages = []
        self.closed = False
        self.received = 0
    async def accept(self): pass
    async def receive(self):
        self.received += 1
        await asyncio.sleep(.001)
        return next(self.frames)
    async def send_text(self, text): self.messages.append(json.loads(text))
    async def close(self): self.closed = True

def tone(seconds, amplitude):
    return struct.pack('<h', amplitude) * int(seconds * 16000)

def frames(pcm, size=3200): return [pcm[i:i+size] for i in range(0, len(pcm), size)]

class StreamTests(unittest.TestCase):
    def setUp(self): self.ns = load_server()
    def tearDown(self): self.ns['_POOL'].shutdown()
    def run_stream(self, pcm):
        durations = []
        def decode(path):
            with wave.open(path) as f:
                values = struct.unpack('<' + 'h' * f.getnframes(), f.readframes(f.getnframes()))
            durations.append(len(values) / 16000)
            if len(values) > 24 * 16000:
                raise FileNotFoundError('longform dependency cwd disappeared')
            first = any(1500 < abs(v) < 2100 for v in values)
            second = any(abs(v) > 4000 for v in values)
            return ' '.join(p for p, present in [('Первая фраза', first), ('Вторая фраза', second)] if present)
        self.ns['transcribe_wav'] = decode
        ws = Socket(frames(pcm))
        asyncio.run(self.ns['ws_stream'](ws))
        return ws, durations
    def test_phrase_survives_long_silence_then_second_phrase(self):
        ws, _ = self.run_stream(tone(2, 2000) + bytes(14 * 32000) + tone(2, 5000))
        partials = [m for m in ws.messages if m['type'] == 'partial']
        seen = False
        for m in partials:
            if 'Первая фраза' in m['text']: seen = True
            if seen: self.assertIn('Первая фраза', m['text'], 'pause must not erase the first phrase')
        self.assertTrue(seen)
        self.assertEqual(ws.messages[-1]['text'], 'Первая фраза Вторая фраза')
    def test_take_longer_than_24_seconds_finishes_without_longform(self):
        ws, durations = self.run_stream(tone(2, 2000) + bytes(28 * 32000) + tone(2, 5000))
        self.assertEqual(ws.messages[-1]['type'], 'final')
        self.assertEqual(ws.messages[-1]['text'], 'Первая фраза Вторая фраза')
        self.assertLessEqual(max(durations), 20)
        self.assertTrue(ws.closed)
    def test_continuous_speech_is_bounded_and_retained(self):
        ws, durations = self.run_stream(tone(22, 2000))
        self.assertEqual(ws.messages[-1]['type'], 'final')
        self.assertLessEqual(max(durations), 20)
        self.assertTrue(ws.messages[-1]['text'].startswith('Первая фраза'))
    def test_silence_does_not_call_decoder_or_invent_text(self):
        ws, durations = self.run_stream(bytes(30 * 32000))
        self.assertEqual(durations, [])
        self.assertEqual(ws.messages[-1]['type'], 'final')
        self.assertEqual(ws.messages[-1]['text'], '')
    def test_stop_commits_subsecond_tail(self):
        ws, durations = self.run_stream(tone(0.05, 2000))
        self.assertEqual(ws.messages[-1]['text'], 'Первая фраза')
        self.assertEqual(len(durations), 1)
    def test_transport_boundaries_do_not_duplicate_or_drop_speech(self):
        from stt_stream import PcmUtterances
        pcm = tone(1.1, 2000) + bytes(2 * 32000) + tone(0.07, 5000)
        outputs = []
        for size in (1, 713, 3200, len(pcm)):
            audio = PcmUtterances()
            for packet in frames(pcm, size): audio.push(packet)
            audio.finish()
            outputs.append(list(audio.completed))
        self.assertTrue(all(result == outputs[0] for result in outputs))
        self.assertEqual(len(outputs[0]), 2)
        self.assertEqual(outputs[0][0][:int(1.1 * 32000)], tone(1.1, 2000))
        self.assertTrue(outputs[0][1].endswith(tone(.07, 5000)))
    def test_slow_partial_decoder_does_not_block_stop_or_queue_old_hypotheses(self):
        import threading
        started, release = threading.Event(), threading.Event()
        calls = []
        def slow_decode(path):
            calls.append(path)
            started.set()
            release.wait(2)
            return 'Сохранённая фраза'
        self.ns['transcribe_wav'] = slow_decode
        packets = frames(tone(4, 2000))
        ws = Socket(packets)
        async def run():
            task = asyncio.create_task(self.ns['ws_stream'](ws))
            try:
                for _ in range(100):
                    if started.is_set(): break
                    await asyncio.sleep(.001)
                await asyncio.sleep(.1)
                self.assertEqual(ws.received, len(packets) + 1, 'stop must be read while inference is running')
            finally:
                release.set()
                await task
            self.assertLessEqual(len(calls), 2, 'old partial snapshots must be coalesced')
            self.assertEqual(ws.messages[-1]['type'], 'final')
        asyncio.run(run())
    def test_offline_longform_import_failure_falls_back(self):
        class Model:
            def transcribe_longform(self, path): raise FileNotFoundError('deleted cwd')
            def transcribe(self, path): return 'Сохранённый текст'
        self.ns['get_model'] = lambda: Model()
        with tempfile.TemporaryDirectory() as tmp:
            path = self.ns['pcm16_to_wav'](tone(25, 2000), os.path.join(tmp, 'a.wav'))
            self.assertEqual(self.ns['transcribe_wav'](path), 'Сохранённый текст Сохранённый текст')

if __name__ == '__main__': unittest.main()
