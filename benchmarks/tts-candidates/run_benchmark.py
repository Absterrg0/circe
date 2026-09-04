from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
BENCHMARK_ROOT = Path(__file__).resolve().parent
WORKER = BENCHMARK_ROOT / "benchmark_worker.py"
POCKET_PYTHON = BENCHMARK_ROOT / ".venv/bin/python"
KOKORO_PYTHON = ROOT / "apps/desktop/pipecat/.venv/bin/python"
KOKORO_MODEL_ROOT_DEFAULT = Path(
    "/home/abstergo/Documents/Jarvis/packages/jarvis-native-voice/resources/kokoro"
)
NATIVE_RUNTIME = (
    ROOT
    / "packages/jarvis-native-voice/node_modules/sherpa-onnx-linux-x64"
)
HF_HOME = BENCHMARK_ROOT / ".cache/huggingface"
SHERPA_POCKET_ROOT_DEFAULT = (
    BENCHMARK_ROOT / ".cache/sherpa-pocket/sherpa-onnx-pocket-tts-int8-2026-01-26"
)
ENGINE_ORDER = (
    "kokoro-current",
    "pocket-fp32",
    "kokoro-phrases",
    "pocket-int8",
    "pocket-sherpa-int8",
)


def _memory_info() -> dict[str, int]:
    result: dict[str, int] = {}
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        name, separator, value = line.partition(":")
        if separator and name in {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}:
            result[name] = int(value.strip().split()[0]) * 1_024
    return result


def _cpu_model() -> str:
    for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
        if line.startswith("model name"):
            return line.partition(":")[2].strip()
    return platform.processor()


def _cpu_frequencies_khz() -> list[int]:
    frequencies: list[int] = []
    for path in sorted(Path("/sys/devices/system/cpu").glob("cpu[0-9]*/cpufreq/scaling_cur_freq")):
        try:
            frequencies.append(int(path.read_text(encoding="utf-8").strip()))
        except (OSError, ValueError):
            pass
    return frequencies


def _directory_sizes(path: Path) -> dict[str, int]:
    if not path.exists():
        return {"apparentBytes": 0, "diskBytes": 0}

    def du(*arguments: str) -> int:
        output = subprocess.check_output(["du", *arguments, str(path)], text=True)
        return int(output.split()[0])

    return {"apparentBytes": du("-sb"), "diskBytes": du("-sB1")}


def _percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * quantile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def _summary(values: list[float]) -> dict[str, float | int]:
    return {
        "samples": len(values),
        "median": statistics.median(values),
        "p05": _percentile(values, 0.05),
        "p95": _percentile(values, 0.95),
        "minimum": min(values),
        "maximum": max(values),
    }


def _aggregate(runs: list[dict[str, Any]]) -> dict[str, Any]:
    metric_names = (
        "firstChunkMs",
        "firstAudiblePcmMs",
        "synthesisWallMs",
        "synthesisCpuMs",
        "realTimeFactor",
        "speedX",
        "streamPlayoutEndMs",
        "playoutGapCount",
        "playoutUnderrunMs",
        "audioDurationMs",
        "chunkCount",
        "leadingSilenceMs",
        "trailingSilenceMs",
        "rmsDbfs",
        "peakDbfs",
        "clippedSamplePercent",
        "maximumJoinStep",
    )
    result: dict[str, Any] = {}
    for engine in ENGINE_ORDER:
        engine_runs = [run for run in runs if run["engine"] == engine]
        if not engine_runs:
            continue
        groups: dict[str, Any] = {}
        trials = [trial for run in engine_runs for trial in run["trials"]]
        for phase, scenario in (("cold", "typical"), *(('warm', name) for name in ("short", "typical", "long"))):
            selected = [
                trial
                for trial in trials
                if trial["phase"] == phase and trial["scenario"] == scenario
            ]
            groups[f"{phase}:{scenario}"] = {
                metric: _summary([float(trial[metric]) for trial in selected if trial[metric] is not None])
                for metric in metric_names
                if any(trial[metric] is not None for trial in selected)
            }
        result[engine] = {
            "engineVersion": engine_runs[0]["engineVersion"],
            "python": engine_runs[0]["python"],
            "processToReadyMs": _summary([float(run["processToReadyMs"]) for run in engine_runs]),
            "engineImportMs": _summary([float(run["engineImportMs"]) for run in engine_runs]),
            "modelLoadMs": _summary([float(run["modelLoadMs"]) for run in engine_runs]),
            "voiceLoadMs": _summary([float(run["voiceLoadMs"]) for run in engine_runs]),
            "readyRssBytes": _summary(
                [float(run["readyMemory"]["rssBytes"]) for run in engine_runs]
            ),
            "peakRssBytes": _summary(
                [float(run["finalMemory"]["peakRssBytes"]) for run in engine_runs]
            ),
            "groups": groups,
        }
    return result


def _worker_command(
    engine: str,
    run_index: int,
    warm_runs: int,
    sample_dir: Path | None,
    kokoro_model_root: Path,
    sherpa_pocket_root: Path,
) -> tuple[list[str], dict[str, str]]:
    environment = os.environ.copy()
    arguments = [
        str(WORKER),
        f"--engine={engine}",
        f"--run-index={run_index}",
        f"--warm-runs={warm_runs}",
    ]
    if sample_dir is not None:
        arguments.append(f"--sample-dir={sample_dir}")
    if engine in {"pocket-fp32", "pocket-int8"}:
        python = POCKET_PYTHON
        environment["HF_HOME"] = str(HF_HOME)
        environment["TOKENIZERS_PARALLELISM"] = "false"
    else:
        python = KOKORO_PYTHON
        model_root = (
            sherpa_pocket_root if engine == "pocket-sherpa-int8" else kokoro_model_root
        )
        arguments.append(f"--model-root={model_root}")
        existing = environment.get("LD_LIBRARY_PATH", "")
        environment["LD_LIBRARY_PATH"] = (
            str(NATIVE_RUNTIME) if not existing else f"{NATIVE_RUNTIME}{os.pathsep}{existing}"
        )
    # Both engines use two active CPU threads. Pinning them to the two physical
    # performance cores avoids the hybrid scheduler moving one run to an E-core.
    return ["taskset", "--cpu-list", "0,2", str(python), *arguments], environment


def _run_worker(
    engine: str,
    run_index: int,
    warm_runs: int,
    sample_dir: Path | None,
    kokoro_model_root: Path,
    sherpa_pocket_root: Path,
) -> dict[str, Any]:
    command, environment = _worker_command(
        engine, run_index, warm_runs, sample_dir, kokoro_model_root, sherpa_pocket_root
    )
    started = time.perf_counter()
    completed = subprocess.run(
        command,
        cwd=ROOT,
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    elapsed_ms = (time.perf_counter() - started) * 1_000
    if completed.returncode != 0:
        raise RuntimeError(
            f"{engine} run {run_index} failed ({completed.returncode}).\n"
            f"stdout:\n{completed.stdout[-4_000:]}\nstderr:\n{completed.stderr[-4_000:]}"
        )
    lines = [line for line in completed.stdout.splitlines() if line.startswith("{")]
    if not lines:
        raise RuntimeError(f"{engine} emitted no JSON result: {completed.stdout[-4_000:]}")
    result = json.loads(lines[-1])
    result["subprocessWallMs"] = elapsed_ms
    if completed.stderr.strip():
        result["stderrTail"] = completed.stderr.strip()[-2_000:]
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cold-runs", type=int, default=3)
    parser.add_argument("--warm-runs", type=int, default=5)
    parser.add_argument("--model-root", type=Path, default=KOKORO_MODEL_ROOT_DEFAULT)
    parser.add_argument(
        "--sherpa-pocket-root", type=Path, default=SHERPA_POCKET_ROOT_DEFAULT
    )
    parser.add_argument("--engines", default=",".join(ENGINE_ORDER))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--samples", type=Path, default=BENCHMARK_ROOT / "samples")
    arguments = parser.parse_args()
    if arguments.cold_runs < 2 or arguments.cold_runs > 10:
        parser.error("--cold-runs must be between 2 and 10")
    if arguments.warm_runs < 3 or arguments.warm_runs > 20:
        parser.error("--warm-runs must be between 3 and 20")
    if not arguments.model_root.is_dir():
        parser.error(f"Kokoro model root does not exist: {arguments.model_root}")
    engines = tuple(name.strip() for name in arguments.engines.split(",") if name.strip())
    unknown_engines = set(engines) - set(ENGINE_ORDER)
    if not engines or unknown_engines:
        parser.error(f"Unknown or empty --engines value: {arguments.engines}")
    if "pocket-sherpa-int8" in engines and not arguments.sherpa_pocket_root.is_dir():
        parser.error(f"Sherpa PocketTTS root does not exist: {arguments.sherpa_pocket_root}")

    output = arguments.output or BENCHMARK_ROOT / "results.json"
    runs: list[dict[str, Any]] = []
    memory_at_start = _memory_info()
    frequencies_at_start = _cpu_frequencies_khz()
    orders = (
        engines,
        tuple(reversed(engines)),
        engines[2:] + engines[:2],
    )
    for run_index in range(arguments.cold_runs):
        order = orders[run_index % len(orders)]
        for engine in order:
            warm_runs = arguments.warm_runs if run_index == 0 else 0
            sample_dir = arguments.samples if run_index == 0 and warm_runs else None
            print(
                f"running {engine}: cold {run_index + 1}/{arguments.cold_runs}"
                + (f", {warm_runs} warm runs per text" if warm_runs else ""),
                flush=True,
            )
            runs.append(
                _run_worker(
                    engine,
                    run_index,
                    warm_runs,
                    sample_dir,
                    arguments.model_root.resolve(),
                    arguments.sherpa_pocket_root.resolve(),
                )
            )

    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    result = {
        "schemaVersion": 1,
        "createdAt": datetime.now().astimezone().isoformat(),
        "method": {
            "coldRuns": arguments.cold_runs,
            "warmRunsPerScenario": arguments.warm_runs,
            "cpuAffinity": [0, 2],
            "audibleThresholdDbfs": -45.0,
            "audibleWindowMs": 10.0,
            "coldDefinition": "fresh process with model files in the OS page cache",
            "firstAudibleDefinition": (
                "request to the first 10 ms PCM window at or above -45 dBFS, simulated through "
                "an immediate streaming sink; DAC and hardware buffering are excluded"
            ),
        },
        "system": {
            "cpu": _cpu_model(),
            "logicalCpuCount": os.cpu_count(),
            "os": f"{platform.system()} {platform.release()}",
            "machine": platform.machine(),
            "memoryAtStart": memory_at_start,
            "memoryAtEnd": _memory_info(),
            "loadAverageAtEnd": os.getloadavg(),
            "cpuFrequenciesKhzAtStart": frequencies_at_start,
            "cpuFrequenciesKhzAtEnd": _cpu_frequencies_khz(),
            "gitCommit": commit,
        },
        "footprint": {
            "kokoroModel": _directory_sizes(arguments.model_root),
            "kokoroPythonEnvironment": _directory_sizes(KOKORO_PYTHON.parents[1]),
            "pocketModelCache": _directory_sizes(HF_HOME),
            "sherpaPocketModel": _directory_sizes(arguments.sherpa_pocket_root),
            "pocketPythonEnvironment": _directory_sizes(POCKET_PYTHON.parents[1]),
        },
        "runs": runs,
        "summary": _aggregate(runs),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {output}", flush=True)


if __name__ == "__main__":
    main()
