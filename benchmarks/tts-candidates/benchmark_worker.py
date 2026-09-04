from __future__ import annotations

PROCESS_STARTED_AT = __import__("time").perf_counter()

import argparse
import json
import math
import os
import platform
import re
import sys
import time
import wave
from pathlib import Path
from typing import Any, Callable


TEXTS = {
    "short": "Done.",
    "typical": (
        "The task is complete. I updated the login flow and added regression tests. "
        "All targeted checks passed. You can review the changes in the workspace."
    ),
    "long": (
        "I finished the requested update and checked the paths that share this behavior. "
        "The desktop client now keeps the selected task stable across reconnects, while the "
        "mobile client reports a disconnected node instead of silently moving work elsewhere. "
        "Focused tests cover local and remote routing, cancellation, and the reverse transition. "
        "The targeted typecheck and test files pass, and no live user data was opened or changed."
    ),
}

ENGINE_IDS = (
    "kokoro-current",
    "kokoro-phrases",
    "pocket-fp32",
    "pocket-int8",
    "pocket-sherpa-int8",
)
AUDIBLE_RMS_DBFS = -45.0
AUDIBLE_WINDOW_MS = 10.0


def _memory_bytes() -> dict[str, int]:
    values: dict[str, int] = {}
    try:
        for line in Path("/proc/self/status").read_text(encoding="utf-8").splitlines():
            name, separator, value = line.partition(":")
            if separator and name in {"VmRSS", "VmHWM", "VmSize"}:
                values[name] = int(value.strip().split()[0]) * 1024
    except (FileNotFoundError, OSError, ValueError):
        pass
    return {
        "rssBytes": values.get("VmRSS", 0),
        "peakRssBytes": values.get("VmHWM", 0),
        "virtualBytes": values.get("VmSize", 0),
    }


def split_kokoro_phrases(text: str, max_words: int = 10) -> list[str]:
    """Split finalized speech at punctuation, then bound long clauses."""
    clauses = [part.strip() for part in re.split(r"(?<=[.!?;:,])\s+", text) if part.strip()]
    phrases: list[str] = []
    for clause in clauses:
        words = clause.split()
        while len(words) > max_words:
            phrases.append(" ".join(words[:max_words]).rstrip(".!?;:,") + ",")
            words = words[max_words:]
        if words:
            phrase = " ".join(words)
            if phrase[-1] not in ".!?;:,":
                phrase += "."
            phrases.append(phrase)
    return phrases


def _audible_onset(samples: Any, sample_rate: int, np: Any) -> int | None:
    if samples.size == 0:
        return None
    window = max(1, round(sample_rate * AUDIBLE_WINDOW_MS / 1_000))
    if samples.size < window:
        rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
        return 0 if rms >= 10 ** (AUDIBLE_RMS_DBFS / 20) else None
    squared = np.square(samples, dtype=np.float64)
    cumulative = np.concatenate((np.zeros(1, dtype=np.float64), np.cumsum(squared)))
    window_rms = np.sqrt((cumulative[window:] - cumulative[:-window]) / window)
    audible = np.flatnonzero(window_rms >= 10 ** (AUDIBLE_RMS_DBFS / 20))
    return int(audible[0]) if audible.size else None


def _signal_metrics(samples: Any, sample_rate: int, np: Any) -> dict[str, float | int | None]:
    if samples.size == 0:
        raise RuntimeError("The engine produced no audio.")
    onset = _audible_onset(samples, sample_rate, np)
    reversed_onset = _audible_onset(samples[::-1].copy(), sample_rate, np)
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    peak = float(np.max(np.abs(samples)))
    return {
        "sampleCount": int(samples.size),
        "audioDurationMs": float(samples.size * 1_000 / sample_rate),
        "leadingSilenceMs": None if onset is None else float(onset * 1_000 / sample_rate),
        "trailingSilenceMs": (
            None if reversed_onset is None else float(reversed_onset * 1_000 / sample_rate)
        ),
        "rmsDbfs": 20 * math.log10(max(rms, 1e-12)),
        "peakDbfs": 20 * math.log10(max(peak, 1e-12)),
        "dcOffset": float(np.mean(samples, dtype=np.float64)),
        "clippedSamplePercent": float(np.mean(np.abs(samples) >= 0.999) * 100),
    }


def _stream_metrics(
    chunks: list[tuple[float, Any]],
    sample_rate: int,
    wall_ms: float,
    cpu_ms: float,
    boundaries: list[int],
    np: Any,
) -> tuple[dict[str, Any], Any]:
    if not chunks:
        raise RuntimeError("The engine emitted no streaming chunks.")
    samples = np.concatenate([chunk for _, chunk in chunks]).astype(np.float32, copy=False)
    signal = _signal_metrics(samples, sample_rate, np)
    onset = _audible_onset(samples, sample_rate, np)

    playout_end_ms = 0.0
    playout_gap_count = 0
    playout_underrun_ms = 0.0
    first_audible_pcm_ms: float | None = None
    sample_offset = 0
    for chunk_index, (arrival_ms, chunk) in enumerate(chunks):
        if chunk_index > 0 and arrival_ms > playout_end_ms:
            playout_gap_count += 1
            playout_underrun_ms += arrival_ms - playout_end_ms
        chunk_start_ms = max(arrival_ms, playout_end_ms)
        chunk_end_offset = sample_offset + int(chunk.size)
        if onset is not None and sample_offset <= onset < chunk_end_offset:
            first_audible_pcm_ms = chunk_start_ms + (onset - sample_offset) * 1_000 / sample_rate
        playout_end_ms = chunk_start_ms + chunk.size * 1_000 / sample_rate
        sample_offset = chunk_end_offset

    boundary_steps = [
        abs(float(samples[index]) - float(samples[index - 1]))
        for index in boundaries
        if 0 < index < samples.size
    ]
    duration_ms = float(signal["audioDurationMs"])
    result: dict[str, Any] = {
        "firstChunkMs": chunks[0][0],
        "firstChunkAudioMs": chunks[0][1].size * 1_000 / sample_rate,
        "firstAudiblePcmMs": first_audible_pcm_ms,
        "synthesisWallMs": wall_ms,
        "synthesisCpuMs": cpu_ms,
        "processCpuPercentOfOneCore": cpu_ms / wall_ms * 100 if wall_ms else 0.0,
        "realTimeFactor": wall_ms / duration_ms,
        "speedX": duration_ms / wall_ms,
        "streamPlayoutEndMs": playout_end_ms,
        "playoutGapCount": playout_gap_count,
        "playoutUnderrunMs": playout_underrun_ms,
        "chunkCount": len(chunks),
        "joinCount": len(boundary_steps),
        "maximumJoinStep": max(boundary_steps) if boundary_steps else None,
        **signal,
    }
    return result, samples


def _write_wav(path: Path, samples: Any, sample_rate: int, np: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.rint(np.clip(samples, -1.0, 1.0) * 32_767).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm.tobytes())


def _load_kokoro(
    model_root: Path, np: Any
) -> tuple[int, Callable[[str, int], tuple[Any, Any]], dict[str, float]]:
    import_started = time.perf_counter()
    from jarvis_voice_runtime.kokoro import (
        KOKORO_SILENCE_SCALE,
        KOKORO_SPEAKER_ID,
        KOKORO_SPEED,
        create_tts,
    )
    import sherpa_onnx

    engine_import_ms = (time.perf_counter() - import_started) * 1_000
    model_started = time.perf_counter()
    model = create_tts(model_root)
    model_load_ms = (time.perf_counter() - model_started) * 1_000
    sample_rate = int(model.sample_rate)

    def synthesize(text: str, seed: int, *, phrases: bool = False) -> tuple[Any, Any]:
        del seed
        started = time.perf_counter()
        chunks: list[tuple[float, Any]] = []
        boundaries: list[int] = []
        total_samples = 0
        segments = split_kokoro_phrases(text) if phrases else [text]
        for segment_index, segment in enumerate(segments):
            accepted: list[Any] = []

            def on_progress(values: object, _progress: float) -> int:
                chunk = np.asarray(values, dtype=np.float32).reshape(-1).copy()
                if chunk.size:
                    chunks.append(((time.perf_counter() - started) * 1_000, chunk))
                    accepted.append(chunk)
                return 1

            config = sherpa_onnx.GenerationConfig()
            config.sid = KOKORO_SPEAKER_ID
            config.speed = KOKORO_SPEED
            config.silence_scale = KOKORO_SILENCE_SCALE
            generated = model.generate(segment, config, on_progress)
            complete = np.asarray(generated.samples, dtype=np.float32).reshape(-1)
            accepted_count = sum(int(chunk.size) for chunk in accepted)
            if accepted_count:
                accepted_pcm = np.concatenate(accepted)
                if not np.array_equal(complete[:accepted_count], accepted_pcm):
                    raise RuntimeError("Kokoro callback audio is not a prefix of final audio.")
            if accepted_count < complete.size:
                chunks.append(
                    ((time.perf_counter() - started) * 1_000, complete[accepted_count:].copy())
                )
            total_samples += int(complete.size)
            if segment_index + 1 < len(segments):
                boundaries.append(total_samples)
        return chunks, boundaries

    return sample_rate, synthesize, {
        "engineImportMs": engine_import_ms,
        "modelLoadMs": model_load_ms,
        "voiceLoadMs": 0.0,
    }


def _load_pocket(
    quantize: bool, np: Any
) -> tuple[int, Callable[[str, int], tuple[Any, Any]], dict[str, float]]:
    import_started = time.perf_counter()
    import torch
    from pocket_tts import TTSModel

    engine_import_ms = (time.perf_counter() - import_started) * 1_000
    model_started = time.perf_counter()
    model = TTSModel.load_model(language="english", quantize=quantize)
    model_load_ms = (time.perf_counter() - model_started) * 1_000
    voice_started = time.perf_counter()
    voice = model.get_state_for_audio_prompt("alba")
    voice_ms = (time.perf_counter() - voice_started) * 1_000

    def synthesize(text: str, seed: int) -> tuple[Any, Any]:
        torch.manual_seed(seed)
        started = time.perf_counter()
        chunks: list[tuple[float, Any]] = []
        for tensor in model.generate_audio_stream(voice, text, copy_state=True):
            chunk = tensor.detach().cpu().numpy().astype(np.float32, copy=True).reshape(-1)
            if chunk.size:
                chunks.append(((time.perf_counter() - started) * 1_000, chunk))
        return chunks, []

    return int(model.sample_rate), synthesize, {
        "engineImportMs": engine_import_ms,
        "modelLoadMs": model_load_ms,
        "voiceLoadMs": voice_ms,
    }


def _load_sherpa_pocket(
    model_root: Path, np: Any
) -> tuple[int, Callable[[str, int], tuple[Any, Any]], dict[str, float]]:
    import_started = time.perf_counter()
    import sherpa_onnx

    engine_import_ms = (time.perf_counter() - import_started) * 1_000
    model_config = sherpa_onnx.OfflineTtsPocketModelConfig(
        lm_flow=str(model_root / "lm_flow.int8.onnx"),
        lm_main=str(model_root / "lm_main.int8.onnx"),
        encoder=str(model_root / "encoder.onnx"),
        decoder=str(model_root / "decoder.int8.onnx"),
        text_conditioner=str(model_root / "text_conditioner.onnx"),
        vocab_json=str(model_root / "vocab.json"),
        token_scores_json=str(model_root / "token_scores.json"),
    )
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            pocket=model_config,
            num_threads=2,
            debug=False,
            provider="cpu",
        )
    )
    if not config.validate():
        raise RuntimeError("The Sherpa PocketTTS configuration is invalid.")
    model_started = time.perf_counter()
    model = sherpa_onnx.OfflineTts(config)
    model_load_ms = (time.perf_counter() - model_started) * 1_000

    voice_started = time.perf_counter()
    reference_path = model_root / "test_wavs/loona.wav"
    with wave.open(str(reference_path), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise RuntimeError("Sherpa PocketTTS reference audio must be mono PCM-S16LE.")
        reference_sample_rate = source.getframerate()
        reference_audio = (
            np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32)
            / 32_768.0
        )
    voice_load_ms = (time.perf_counter() - voice_started) * 1_000

    def synthesize(text: str, seed: int) -> tuple[Any, Any]:
        del seed
        started = time.perf_counter()
        chunks: list[tuple[float, Any]] = []

        def on_progress(values: object, _progress: float) -> int:
            chunk = np.asarray(values, dtype=np.float32).reshape(-1).copy()
            if chunk.size:
                chunks.append(((time.perf_counter() - started) * 1_000, chunk))
            return 1

        generation = sherpa_onnx.GenerationConfig()
        generation.reference_audio = reference_audio
        generation.reference_sample_rate = reference_sample_rate
        generation.num_steps = 1
        generated = model.generate(text, generation, on_progress)
        if not chunks:
            complete = np.asarray(generated.samples, dtype=np.float32).reshape(-1)
            if complete.size:
                chunks.append(((time.perf_counter() - started) * 1_000, complete.copy()))
        return chunks, []

    return int(model.sample_rate), synthesize, {
        "engineImportMs": engine_import_ms,
        "modelLoadMs": model_load_ms,
        "voiceLoadMs": voice_load_ms,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=ENGINE_IDS, required=True)
    parser.add_argument("--model-root", type=Path)
    parser.add_argument("--warm-runs", type=int, default=5)
    parser.add_argument("--sample-dir", type=Path)
    parser.add_argument("--run-index", type=int, default=0)
    arguments = parser.parse_args()
    if arguments.warm_runs < 0 or arguments.warm_runs > 20:
        parser.error("--warm-runs must be between 0 and 20")

    baseline_memory = _memory_bytes()
    import_started = time.perf_counter()
    import numpy as np
    common_import_ms = (time.perf_counter() - import_started) * 1_000

    if arguments.engine.startswith("kokoro"):
        if arguments.model_root is None:
            parser.error("Kokoro requires --model-root")
        sample_rate, base_synthesize, load_timing = _load_kokoro(arguments.model_root, np)
        phrase_mode = arguments.engine == "kokoro-phrases"

        def synthesize(text: str, seed: int) -> tuple[Any, Any]:
            return base_synthesize(text, seed, phrases=phrase_mode)

        package_version = __import__("importlib.metadata").metadata.version("sherpa-onnx")
    elif arguments.engine == "pocket-sherpa-int8":
        if arguments.model_root is None:
            parser.error("Sherpa PocketTTS requires --model-root")
        sample_rate, synthesize, load_timing = _load_sherpa_pocket(arguments.model_root, np)
        package_version = __import__("importlib.metadata").metadata.version("sherpa-onnx")
    else:
        sample_rate, synthesize, load_timing = _load_pocket(
            arguments.engine == "pocket-int8", np
        )
        package_version = __import__("importlib.metadata").metadata.version("pocket-tts")
    ready_at = time.perf_counter()
    ready_memory = _memory_bytes()

    trials: list[dict[str, Any]] = []

    def run_trial(scenario: str, phase: str, repetition: int) -> None:
        text = TEXTS[scenario]
        seed = 10_000 + arguments.run_index * 100 + len(text)
        started = time.perf_counter()
        cpu_started = time.process_time()
        chunks, boundaries = synthesize(text, seed)
        wall_ms = (time.perf_counter() - started) * 1_000
        cpu_ms = (time.process_time() - cpu_started) * 1_000
        metrics, samples = _stream_metrics(
            chunks, sample_rate, wall_ms, cpu_ms, boundaries, np
        )
        trials.append(
            {
                "scenario": scenario,
                "phase": phase,
                "repetition": repetition,
                "textCharacters": len(text),
                "textWords": len(text.split()),
                **metrics,
                "memoryAfter": _memory_bytes(),
            }
        )
        if arguments.sample_dir is not None and phase == "warm" and repetition == 0:
            _write_wav(
                arguments.sample_dir / f"{arguments.engine}-{scenario}.wav",
                samples,
                sample_rate,
                np,
            )

    run_trial("typical", "cold", 0)
    for repetition in range(arguments.warm_runs):
        for scenario in TEXTS:
            run_trial(scenario, "warm", repetition)

    print(
        json.dumps(
            {
                "engine": arguments.engine,
                "engineVersion": package_version,
                "python": platform.python_version(),
                "runIndex": arguments.run_index,
                "sampleRate": sample_rate,
                "baselineMemory": baseline_memory,
                "readyMemory": ready_memory,
                "commonImportMs": common_import_ms,
                **load_timing,
                "processToReadyMs": (ready_at - PROCESS_STARTED_AT) * 1_000,
                "finalMemory": _memory_bytes(),
                "trials": trials,
            },
            separators=(",", ":"),
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
