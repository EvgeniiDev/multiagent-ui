"""Bounded PCM utterances: silence commits a phrase, never a rolling text window."""
from array import array
from collections import deque
import sys


class PcmUtterances:
    RATE = 16000
    FRAME_BYTES = 640  # 20 ms PCM16, independent of WebSocket packet boundaries

    def __init__(self, silence_s=0.8, max_s=20.0, rms_threshold=200):
        self.silence_bytes = int(silence_s * self.RATE) * 2
        self.max_bytes = int(max_s * self.RATE) * 2
        self.threshold_squared = rms_threshold ** 2
        self.pad_bytes = int(0.2 * self.RATE) * 2
        self.pending = bytearray()
        self.active = bytearray()
        self.leading = bytearray()
        self.silent_bytes = 0
        self.completed = deque()
        self.received_bytes = 0
        self.sequence = 0

    def push(self, pcm):
        self.received_bytes += len(pcm)
        self.pending.extend(pcm)
        while len(self.pending) >= self.FRAME_BYTES:
            block = bytes(self.pending[:self.FRAME_BYTES])
            del self.pending[:self.FRAME_BYTES]
            self._consume(block)

    def _consume(self, block):
        samples = array('h', block)
        if sys.byteorder != 'little':
            samples.byteswap()
        voiced = bool(samples) and sum(s * s for s in samples) > self.threshold_squared * len(samples)
        if not self.active and not voiced:
            self.leading.extend(block)
            del self.leading[:-self.pad_bytes]
            return
        if not self.active:
            self.active.extend(self.leading)
            self.leading.clear()
        self.active.extend(block)
        self.silent_bytes = 0 if voiced else self.silent_bytes + len(block)
        if self.silent_bytes >= self.silence_bytes:
            # Retain a short tail for word endings; don't decode a long pause.
            del self.active[len(self.active) - self.silent_bytes + self.pad_bytes:]
            self._complete()
        elif len(self.active) >= self.max_bytes:
            self._complete()

    def _complete(self):
        if self.active:
            self.completed.append(bytes(self.active))
        self.active.clear()
        self.silent_bytes = 0
        self.sequence += 1

    def finish(self):
        # Process even a final sub-frame; a dangling byte cannot form PCM16.
        tail = bytes(self.pending[:len(self.pending) // 2 * 2])
        self.pending.clear()
        if tail:
            self._consume(tail)
        self._complete()
