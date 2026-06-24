"""ONNX embedding helper for sentence-transformers/all-MiniLM-L6-v2.

Downloads the model and tokenizer from Hugging Face, then produces normalized
384-dimensional sentence embeddings suitable for Zvec VECTOR_FP32 fields.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer


DEFAULT_REPO_ID = "sentence-transformers/all-MiniLM-L6-v2"
DEFAULT_ONNX_FILE = "onnx/model.onnx"
DEFAULT_MAX_LENGTH = 256
EMBEDDING_DIMENSION = 384


@dataclass(frozen=True)
class MiniLMOnnxFiles:
    model_path: Path
    tokenizer_path: Path


def download_minilm_onnx(
    cache_dir: str | Path = ".cache/huggingface",
    repo_id: str = DEFAULT_REPO_ID,
    onnx_file: str = DEFAULT_ONNX_FILE,
) -> MiniLMOnnxFiles:
    cache_dir = Path(cache_dir)
    model_path = hf_hub_download(
        repo_id=repo_id,
        filename=onnx_file,
        cache_dir=str(cache_dir),
    )
    tokenizer_path = hf_hub_download(
        repo_id=repo_id,
        filename="tokenizer.json",
        cache_dir=str(cache_dir),
    )
    return MiniLMOnnxFiles(
        model_path=Path(model_path),
        tokenizer_path=Path(tokenizer_path),
    )


class MiniLMOnnxEmbedder:
    def __init__(
        self,
        cache_dir: str | Path = ".cache/huggingface",
        repo_id: str = DEFAULT_REPO_ID,
        onnx_file: str = DEFAULT_ONNX_FILE,
        max_length: int = DEFAULT_MAX_LENGTH,
    ) -> None:
        files = download_minilm_onnx(cache_dir, repo_id, onnx_file)
        self.max_length = max_length
        self.tokenizer = Tokenizer.from_file(str(files.tokenizer_path))
        self.tokenizer.enable_truncation(max_length=max_length)
        self.tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
        self.session = ort.InferenceSession(
            str(files.model_path),
            providers=["CPUExecutionProvider"],
        )
        self.input_names = {item.name for item in self.session.get_inputs()}

    def encode(self, texts: str | Iterable[str]) -> np.ndarray:
        single = isinstance(texts, str)
        batch = [texts] if single else list(texts)
        if not batch:
            return np.empty((0, EMBEDDING_DIMENSION), dtype=np.float32)

        encoded = self.tokenizer.encode_batch(batch)
        input_ids = np.asarray([item.ids for item in encoded], dtype=np.int64)
        attention_mask = np.asarray(
            [item.attention_mask for item in encoded],
            dtype=np.int64,
        )
        token_type_ids = np.asarray([item.type_ids for item in encoded], dtype=np.int64)

        inputs: dict[str, np.ndarray] = {}
        if "input_ids" in self.input_names:
            inputs["input_ids"] = input_ids
        if "attention_mask" in self.input_names:
            inputs["attention_mask"] = attention_mask
        if "token_type_ids" in self.input_names:
            inputs["token_type_ids"] = token_type_ids

        token_embeddings = self.session.run(None, inputs)[0]
        sentence_embeddings = mean_pool(token_embeddings, attention_mask)
        sentence_embeddings = normalize(sentence_embeddings)
        return sentence_embeddings[0] if single else sentence_embeddings


def mean_pool(token_embeddings: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    mask = attention_mask[..., None].astype(np.float32)
    summed = np.sum(token_embeddings * mask, axis=1)
    counts = np.clip(np.sum(mask, axis=1), a_min=1e-9, a_max=None)
    return summed / counts


def normalize(embeddings: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(embeddings, ord=2, axis=1, keepdims=True)
    return (embeddings / np.clip(norms, a_min=1e-12, a_max=None)).astype(np.float32)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("text", nargs="+")
    parser.add_argument("--cache-dir", default=".cache/huggingface")
    parser.add_argument("--onnx-file", default=DEFAULT_ONNX_FILE)
    args = parser.parse_args()

    embedder = MiniLMOnnxEmbedder(
        cache_dir=args.cache_dir,
        onnx_file=args.onnx_file,
    )
    embeddings = embedder.encode(args.text)
    if embeddings.ndim == 1:
        embeddings = embeddings[None, :]

    payload = [
        {
            "text": text,
            "dimension": int(vector.shape[0]),
            "norm": float(np.linalg.norm(vector)),
            "preview": vector[:8].round(6).tolist(),
        }
        for text, vector in zip(args.text, embeddings, strict=True)
    ]
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
