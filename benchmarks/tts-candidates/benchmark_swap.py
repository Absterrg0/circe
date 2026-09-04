from __future__ import annotations

import argparse
import ctypes
import gc
import json
import time
from pathlib import Path
from typing import Any

from benchmark_worker import TEXTS, _memory_bytes, _stream_metrics


def trim_memory() -> float:
    started = time.perf_counter()
    gc.collect()
    try:
        libc = ctypes.CDLL("libc.so.6")
        libc.malloc_trim(0)
    except (AttributeError, OSError):
        pass
    return (time.perf_counter() - started) * 1_000


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parakeet-root", type=Path, required=True)
    parser.add_argument("--cycles", type=int, default=3)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    if arguments.cycles < 2 or arguments.cycles > 10:
        parser.error("--cycles must be between 2 and 10")

    import numpy as np
    import torch
    from jarvis_voice_runtime.parakeet import create_recognizer
    from pocket_tts import TTSModel

    records: list[dict[str, Any]] = []
    baseline = _memory_bytes()
    text = TEXTS["typical"]
    for cycle in range(arguments.cycles):
        parakeet_started = time.perf_counter()
        recognizer = create_recognizer(arguments.parakeet_root)
        parakeet_load_ms = (time.perf_counter() - parakeet_started) * 1_000
        parakeet_memory = _memory_bytes()

        del recognizer
        parakeet_release_ms = trim_memory()
        after_parakeet_release = _memory_bytes()

        pocket_started = time.perf_counter()
        model = TTSModel.load_model(language="english", quantize=True)
        model_load_ms = (time.perf_counter() - pocket_started) * 1_000
        voice_started = time.perf_counter()
        voice = model.get_state_for_audio_prompt("alba")
        voice_load_ms = (time.perf_counter() - voice_started) * 1_000
        pocket_ready_memory = _memory_bytes()

        torch.manual_seed(10_000)
        synthesis_started = time.perf_counter()
        synthesis_cpu_started = time.process_time()
        chunks: list[tuple[float, Any]] = []
        for tensor in model.generate_audio_stream(voice, text, copy_state=True):
            chunk = tensor.detach().cpu().numpy().astype(np.float32, copy=True).reshape(-1)
            if chunk.size:
                chunks.append(((time.perf_counter() - synthesis_started) * 1_000, chunk))
        synthesis_wall_ms = (time.perf_counter() - synthesis_started) * 1_000
        synthesis_cpu_ms = (time.process_time() - synthesis_cpu_started) * 1_000
        synthesis, samples = _stream_metrics(
            chunks, int(model.sample_rate), synthesis_wall_ms, synthesis_cpu_ms, [], np
        )
        pocket_after_synthesis = _memory_bytes()
        prepare_to_first_audible_ms = (
            model_load_ms + voice_load_ms + float(synthesis["firstAudiblePcmMs"])
        )

        del samples, chunks, voice, model
        pocket_release_ms = trim_memory()
        after_pocket_release = _memory_bytes()

        return_started = time.perf_counter()
        recognizer = create_recognizer(arguments.parakeet_root)
        return_to_parakeet_ms = (time.perf_counter() - return_started) * 1_000
        returned_parakeet_memory = _memory_bytes()
        del recognizer
        return_release_ms = trim_memory()

        records.append(
            {
                "cycle": cycle,
                "parakeetLoadMs": parakeet_load_ms,
                "parakeetMemory": parakeet_memory,
                "parakeetReleaseMs": parakeet_release_ms,
                "afterParakeetRelease": after_parakeet_release,
                "pocketModelLoadMs": model_load_ms,
                "pocketVoiceLoadMs": voice_load_ms,
                "pocketReadyMemory": pocket_ready_memory,
                "prepareToFirstAudiblePcmMs": prepare_to_first_audible_ms,
                "synthesis": synthesis,
                "pocketAfterSynthesis": pocket_after_synthesis,
                "pocketReleaseMs": pocket_release_ms,
                "afterPocketRelease": after_pocket_release,
                "returnToParakeetMs": return_to_parakeet_ms,
                "returnedParakeetMemory": returned_parakeet_memory,
                "returnReleaseMs": return_release_ms,
                "afterReturnRelease": _memory_bytes(),
            }
        )
        print(f"completed swap cycle {cycle + 1}/{arguments.cycles}", flush=True)

    result = {
        "engine": "pocket-int8",
        "cycles": arguments.cycles,
        "baselineAfterImports": baseline,
        "records": records,
        "finalMemory": _memory_bytes(),
    }
    arguments.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
