#!/usr/bin/env python3
"""Unit tests for the multipart/WAV inspector used by e2e_voice.py."""
import io
import sys
import unittest
import wave
from email.parser import BytesParser
from email.policy import default
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from e2e_voice import STUB, make_mime_envelope, stt_stats, transcribe


class MultipartWavTests(unittest.TestCase):
    def setUp(self):
        output = io.BytesIO()
        with wave.open(output, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\x01\x00\xfe\xff")
        self.wav = output.getvalue()
        self.boundary = "----acp-e2e-boundary"
        self.content_type = f"multipart/form-data; boundary={self.boundary}"
        self.body = (
            f"--{self.boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="recording.wav"\r\n'
            "Content-Type: audio/wav\r\n\r\n"
        ).encode() + self.wav + f"\r\n--{self.boundary}--\r\n".encode()

    def test_envelope_uses_real_crlf_and_parses_multipart_file(self):
        envelope = make_mime_envelope(self.content_type, self.body)
        self.assertIn(b"\r\nContent-Type: " + self.content_type.encode() + b"\r\n\r\n", envelope)
        self.assertNotIn(b"\\r\\n", envelope)
        message = BytesParser(policy=default).parsebytes(envelope)
        self.assertEqual(message.get_content_type(), "multipart/form-data")
        self.assertTrue(message.is_multipart())
        parts = list(message.iter_parts())
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0].get_filename(), "recording.wav")
        self.assertEqual(parts[0].get_payload(decode=True), self.wav)

    def test_e2e_stub_validates_the_multipart_wav_request(self):
        class Request:
            method = "POST"
            post_data_buffer = self.body

            def header_value(_self, name):
                return self.content_type if name.lower() == "content-type" else ""

        class Route:
            request = Request()
            response = None

            def fulfill(_self, **kwargs):
                _self.response = kwargs

        STUB["mode"] = "normal"
        stt_stats.update({"requests": 0, "method": "", "multipart": False,
                          "wav_bytes": 0, "valid_wav": False})
        route = Route()
        transcribe(route)
        self.assertEqual(route.response["status"], 200)
        self.assertEqual(stt_stats["requests"], 1)
        self.assertEqual(stt_stats["method"], "POST")
        self.assertTrue(stt_stats["multipart"])
        self.assertTrue(stt_stats["valid_wav"], stt_stats)


if __name__ == "__main__":
    unittest.main()
