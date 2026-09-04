from __future__ import annotations

import argparse
import json
import re
import time
import wave
from pathlib import Path
from typing import Any

from benchmark_worker import TEXTS


def normalized_words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", text.lower())


def word_error_counts(reference: str, hypothesis: str) -> dict[str, int | float]:
    expected = normalized_words(reference)
    actual = normalized_words(hypothesis)
    table: list[list[tuple[int, int, int, int]]] = [
        [(0, 0, 0, 0) for _ in range(len(actual) + 1)] for _ in range(len(expected) + 1)
    ]
    for index in range(1, len(expected) + 1):
        table[index][0] = (index, 0, index, 0)
    for index in range(1, len(actual) + 1):
        table[0][index] = (index, 0, 0, index)
    for row, expected_word in enumerate(expected, start=1):
        for column, actual_word in enumerate(actual, start=1):
            if expected_word == actual_word:
                table[row][column] = table[row - 1][column - 1]
                continue
            substitution = table[row - 1][column - 1]
            deletion = table[row - 1][column]
            insertion = table[row][column - 1]
            choices = (
                (substitution[0] + 1, substitution[1] + 1, substitution[2], substitution[3]),
                (deletion[0] + 1, deletion[1], deletion[2] + 1, deletion[3]),
                (insertion[0] + 1, insertion[1], insertion[2], insertion[3] + 1),
            )
            table[row][column] = min(choices)
    errors, substitutions, deletions, insertions = table[-1][-1]
    return {
        "referenceWords": len(expected),
        "hypothesisWords": len(actual),
        "errors": errors,
        "substitutions": substitutions,
        "deletions": deletions,
        "insertions": insertions,
        "wordErrorRate": errors / len(expected) if expected else 0.0,
    }


def read_wav(path: Path, np: Any) -> tuple[int, Any]:
    with wave.open(str(path), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError(f"Expected mono signed 16-bit PCM: {path}")
        sample_rate = source.getframerate()
        pcm = source.readframes(source.getnframes())
    return sample_rate, np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32_768.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-dir", type=Path, required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()

    import numpy as np
    from scipy.signal import resample_poly
    from jarvis_voice_runtime.parakeet import create_recognizer

    model_started = time.perf_counter()
    recognizer = create_recognizer(arguments.model_root)
    model_load_ms = (time.perf_counter() - model_started) * 1_000
    records: list[dict[str, Any]] = []
    for path in sorted(arguments.sample_dir.glob("*.wav")):
        engine, scenario = path.stem.rsplit("-", 1)
        sample_rate, samples = read_wav(path, np)
        if sample_rate != 16_000:
            samples = resample_poly(samples, 16_000, sample_rate).astype(np.float32)
        stream = recognizer.create_stream("")
        stream.accept_waveform(16_000, samples)
        started = time.perf_counter()
        recognizer.decode_stream(stream)
        decode_ms = (time.perf_counter() - started) * 1_000
        transcript = str(stream.result.text).strip()
        records.append(
            {
                "engine": engine,
                "scenario": scenario,
                "transcript": transcript,
                "decodeMs": decode_ms,
                **word_error_counts(TEXTS[scenario], transcript),
            }
        )

    summaries: dict[str, Any] = {}
    for engine in sorted({record["engine"] for record in records}):
        selected = [record for record in records if record["engine"] == engine]
        total_words = sum(int(record["referenceWords"]) for record in selected)
        total_errors = sum(int(record["errors"]) for record in selected)
        summaries[engine] = {
            "referenceWords": total_words,
            "errors": total_errors,
            "wordErrorRate": total_errors / total_words,
        }
    result = {
        "recognizer": "jarvis-parakeet-tdt-ctc-110m-int8",
        "modelLoadMs": model_load_ms,
        "method": "24 kHz output resampled to 16 kHz; no contextual hotwords",
        "records": records,
        "summary": summaries,
    }
    arguments.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summaries, indent=2))


if __name__ == "__main__":
    main()
