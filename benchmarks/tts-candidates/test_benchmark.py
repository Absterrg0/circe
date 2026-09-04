from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np


MODULE_PATH = Path(__file__).with_name("benchmark_worker.py")
SPEC = importlib.util.spec_from_file_location("benchmark_worker", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)
sys.modules["benchmark_worker"] = benchmark

QUALITY_SPEC = importlib.util.spec_from_file_location(
    "quality_check", Path(__file__).with_name("quality_check.py")
)
assert QUALITY_SPEC is not None and QUALITY_SPEC.loader is not None
quality = importlib.util.module_from_spec(QUALITY_SPEC)
QUALITY_SPEC.loader.exec_module(quality)


class PhraseSplitTest(unittest.TestCase):
    def test_prefers_punctuation_and_bounds_long_clauses(self) -> None:
        text = "The task is complete. This deliberately long clause has far more than ten words."

        phrases = benchmark.split_kokoro_phrases(text, max_words=5)

        self.assertEqual(
            phrases,
            [
                "The task is complete.",
                "This deliberately long clause has,",
                "far more than ten words.",
            ],
        )


class StreamingMetricTest(unittest.TestCase):
    def test_first_audible_pcm_includes_delivery_and_leading_silence(self) -> None:
        sample_rate = 1_000
        chunks = [
            (100.0, np.concatenate((np.zeros(50), np.full(50, 0.2))).astype(np.float32)),
            (120.0, np.full(100, 0.2, dtype=np.float32)),
        ]

        metrics, _samples = benchmark._stream_metrics(
            chunks,
            sample_rate,
            wall_ms=150.0,
            cpu_ms=100.0,
            boundaries=[],
            np=np,
        )

        self.assertAlmostEqual(metrics["firstChunkMs"], 100.0)
        self.assertAlmostEqual(metrics["leadingSilenceMs"], 41.0)
        self.assertAlmostEqual(metrics["firstAudiblePcmMs"], 141.0)
        self.assertAlmostEqual(metrics["streamPlayoutEndMs"], 300.0)
        self.assertEqual(metrics["playoutGapCount"], 0)
        self.assertAlmostEqual(metrics["playoutUnderrunMs"], 0.0)
        self.assertAlmostEqual(metrics["realTimeFactor"], 0.75)

    def test_playout_waits_when_generation_falls_behind(self) -> None:
        chunks = [
            (100.0, np.full(100, 0.2, dtype=np.float32)),
            (250.0, np.full(100, 0.2, dtype=np.float32)),
        ]

        metrics, _samples = benchmark._stream_metrics(
            chunks,
            sample_rate=1_000,
            wall_ms=300.0,
            cpu_ms=250.0,
            boundaries=[],
            np=np,
        )

        self.assertAlmostEqual(metrics["streamPlayoutEndMs"], 350.0)
        self.assertEqual(metrics["playoutGapCount"], 1)
        self.assertAlmostEqual(metrics["playoutUnderrunMs"], 50.0)


class WordErrorRateTest(unittest.TestCase):
    def test_reports_substitutions_deletions_and_insertions(self) -> None:
        counts = quality.word_error_counts(
            "Jarvis keeps the selected task stable",
            "Jarvis kept selected tasks stable now",
        )

        self.assertEqual(counts["referenceWords"], 6)
        self.assertEqual(counts["errors"], 4)
        self.assertEqual(counts["substitutions"], 2)
        self.assertEqual(counts["deletions"], 1)
        self.assertEqual(counts["insertions"], 1)


if __name__ == "__main__":
    unittest.main()
