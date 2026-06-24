"""macOS local text-to-speech backend using the built-in `say` command."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import List

from openjarvis.core.registry import TTSRegistry
from openjarvis.speech.tts import TTSBackend, TTSResult


@TTSRegistry.register("say")
class SayTTSBackend(TTSBackend):
    """Local macOS speech synthesis via the system `say` utility."""

    backend_id = "say"

    def __init__(self, *, default_voice: str = "", default_rate: int = 200) -> None:
        self._default_voice = default_voice
        self._default_rate = default_rate

    def _say_binary(self) -> str:
        path = shutil.which("say")
        if not path:
            raise RuntimeError("The macOS `say` command is not available")
        return path

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str = "",
        speed: float = 1.0,
        output_format: str = "m4a",
    ) -> TTSResult:
        if not text.strip():
            return TTSResult(
                audio=b"",
                format=output_format,
                voice_id=voice_id or self._default_voice,
                metadata={"backend": "say"},
            )

        say_path = self._say_binary()
        voice = voice_id or self._default_voice
        rate = max(80, min(500, int(round(self._default_rate * max(speed, 0.1)))))

        with tempfile.TemporaryDirectory(prefix="openjarvis-say-") as tmpdir:
            tmp_dir = Path(tmpdir)
            text_path = tmp_dir / "utterance.txt"
            audio_path = tmp_dir / "utterance.m4a"
            text_path.write_text(text, encoding="utf-8")

            cmd = [
                say_path,
                "-o",
                str(audio_path),
                "--file-format=m4af",
                "--data-format=alac",
                "-r",
                str(rate),
                "-f",
                str(text_path),
            ]
            if voice:
                cmd[1:1] = ["-v", voice]

            subprocess.run(
                cmd,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            audio = audio_path.read_bytes()

        return TTSResult(
            audio=audio,
            format=output_format,
            voice_id=voice,
            metadata={"backend": "say", "rate": rate},
        )

    def available_voices(self) -> List[str]:
        try:
            proc = subprocess.run(
                [self._say_binary(), "-v", "?"],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except Exception:
            return []

        voices: List[str] = []
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            voice = line.split()[0]
            if voice not in voices:
                voices.append(voice)
        return voices

    def health(self) -> bool:
        return shutil.which("say") is not None


def ensure_registered() -> None:
    """Re-register the backend after registry resets in tests."""
    if not TTSRegistry.contains("say"):
        TTSRegistry.register_value("say", SayTTSBackend)
