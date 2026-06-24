"""Tests for TTS backend infrastructure."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from openjarvis.core.registry import TTSRegistry
from openjarvis.speech.tts import TTSResult

# ---------------------------------------------------------------------------
# TTSResult tests
# ---------------------------------------------------------------------------


def test_tts_result_dataclass():
    result = TTSResult(
        audio=b"fake-audio-bytes",
        format="mp3",
        duration_seconds=3.5,
        voice_id="jarvis-v1",
    )
    assert result.audio == b"fake-audio-bytes"
    assert result.format == "mp3"
    assert result.duration_seconds == 3.5


def test_tts_result_save(tmp_path):
    result = TTSResult(audio=b"fake-mp3-data", format="mp3")
    out = result.save(tmp_path / "test.mp3")
    assert out.exists()
    assert out.read_bytes() == b"fake-mp3-data"


# ---------------------------------------------------------------------------
# Cartesia backend tests
# ---------------------------------------------------------------------------


def test_cartesia_registered():
    from openjarvis.speech.cartesia_tts import CartesiaTTSBackend

    TTSRegistry.register_value("cartesia", CartesiaTTSBackend)
    assert TTSRegistry.contains("cartesia")


def test_cartesia_synthesize():
    from openjarvis.speech.cartesia_tts import CartesiaTTSBackend

    backend = CartesiaTTSBackend(api_key="fake-key")

    with patch(
        "openjarvis.speech.cartesia_tts._cartesia_synthesize",
        return_value=b"fake-audio-mp3-bytes",
    ):
        result = backend.synthesize("Hello world", voice_id="test-voice")

    assert result.audio == b"fake-audio-mp3-bytes"
    assert result.format == "mp3"
    assert result.voice_id == "test-voice"


# ---------------------------------------------------------------------------
# Say backend tests
# ---------------------------------------------------------------------------


def test_say_registered():
    from openjarvis.speech.say_tts import ensure_registered

    ensure_registered()
    assert TTSRegistry.contains("say")


def test_say_synthesize(monkeypatch):
    from openjarvis.speech.say_tts import SayTTSBackend

    backend = SayTTSBackend()

    monkeypatch.setattr(
        "openjarvis.speech.say_tts.shutil.which",
        lambda _name: "/usr/bin/say",
    )

    def fake_run(cmd, check, stdout, stderr):  # noqa: ANN001
        audio_path = Path(cmd[cmd.index("-o") + 1])
        audio_path.write_bytes(b"fake-say-audio")
        return MagicMock(returncode=0)

    monkeypatch.setattr("openjarvis.speech.say_tts.subprocess.run", fake_run)

    result = backend.synthesize("Hello there", voice_id="Alex", speed=1.1)

    assert result.audio == b"fake-say-audio"
    assert result.format == "m4a"
    assert result.voice_id == "Alex"
    assert result.metadata["backend"] == "say"


# ---------------------------------------------------------------------------
# Kokoro backend tests
# ---------------------------------------------------------------------------


def test_kokoro_registered():
    from openjarvis.speech.kokoro_tts import KokoroTTSBackend

    TTSRegistry.register_value("kokoro", KokoroTTSBackend)
    assert TTSRegistry.contains("kokoro")


def test_kokoro_health_false_without_package():
    from openjarvis.speech.kokoro_tts import KokoroTTSBackend

    backend = KokoroTTSBackend()
    # Without kokoro installed, health returns False
    assert backend.health() is False


# ---------------------------------------------------------------------------
# OpenAI TTS backend tests
# ---------------------------------------------------------------------------


def test_openai_tts_registered():
    from openjarvis.speech.openai_tts import OpenAITTSBackend

    TTSRegistry.register_value("openai_tts", OpenAITTSBackend)
    assert TTSRegistry.contains("openai_tts")


def test_openai_tts_synthesize():
    from openjarvis.speech.openai_tts import OpenAITTSBackend

    backend = OpenAITTSBackend(api_key="fake-key")

    with patch(
        "openjarvis.speech.openai_tts._openai_tts_request",
        return_value=b"fake-openai-audio",
    ):
        result = backend.synthesize("Hello", voice_id="nova")

    assert result.audio == b"fake-openai-audio"
    assert result.voice_id == "nova"
