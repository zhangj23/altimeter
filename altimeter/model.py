"""Model loading, greedy SQL generation, token log-probs and hidden-state features.

Same code runs on the laptop (serving) and the 3060 (labeling) so probe features match.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass

os.environ.setdefault("HF_HUB_OFFLINE", "1")

import torch
from transformers import (AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, StoppingCriteria,
                          StoppingCriteriaList)

from .prompting import extract_sql

DEFAULT_MAX_NEW_TOKENS = 256
SAMPLE_VRAM_BUDGET = int(5.3 * 2**30)  # sample(): keep this process's allocations under ~5.3 GB
SAMPLE_ACT_MARGIN = 400 * 2**20  # decode activations + sampling logits, on top of the KV estimate


@dataclass
class Generation:
    raw: str
    sql: str
    n_prompt: int
    n_gen: int
    logprob_mean: float
    logprob_min: float
    gen_seconds: float
    feat_seconds: float
    # (num_layers + 1, hidden) float16 on CPU; layer 0 = embeddings
    hs_last_prompt: torch.Tensor
    hs_last_gen: torch.Tensor
    hs_mean_gen: torch.Tensor
    token_logprobs: list[float]
    tokens: list[str]


class FenceStop(StoppingCriteria):
    """True once the generated text holds a closed ``` block (an opening and a closing fence)."""

    def __init__(self, tok, n_in: int) -> None:
        self.tok, self.n_in = tok, n_in

    def __call__(self, input_ids: torch.LongTensor, scores: torch.FloatTensor, **kwargs) -> torch.BoolTensor:
        done = [self.tok.decode(row[self.n_in:], skip_special_tokens=True).count("```") >= 2 for row in input_ids]
        return torch.tensor(done, dtype=torch.bool, device=input_ids.device)


class SqlModel:
    def __init__(self, path: str, device: str = "cuda:0") -> None:
        self.device = device
        self.tok = AutoTokenizer.from_pretrained(path)
        self.model = AutoModelForCausalLM.from_pretrained(
            path,
            device_map=device,
            quantization_config=BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16,
                bnb_4bit_use_double_quant=True,
            ),
        )
        self.model.eval()
        eos = self.model.generation_config.eos_token_id
        self.stop_ids = set(eos if isinstance(eos, list) else [eos]) | {self.tok.eos_token_id}
        if self.tok.pad_token_id is not None:
            self.stop_ids.add(self.tok.pad_token_id)

    def prompt_ids(self, messages: list[dict[str, str]]) -> torch.Tensor:
        text = self.tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        return self.tok(text, return_tensors="pt").input_ids.to(self.device)

    @torch.no_grad()
    def generate(self, messages: list[dict[str, str]], max_new_tokens: int = DEFAULT_MAX_NEW_TOKENS,
                 features: str | None = None, stop_at_fence: bool | None = None) -> Generation:
        """Greedy SQL + features. features="cached" (default; ALTIMETER_FEATURES) reuses generate()'s prompt KV
        cache, so the feature pass runs over 1 + n_gen tokens instead of re-reading the whole prompt;
        "full" is the original single forward over prompt + SQL (what the labeling box used). Decoding is the
        same call either way, so the SQL does not depend on this setting. stop_at_fence (ALTIMETER_STOP_FENCE=1)
        ends decoding at the closing ``` of the first sql block."""
        features = features or os.environ.get("ALTIMETER_FEATURES", "cached")
        if stop_at_fence is None:
            stop_at_fence = os.environ.get("ALTIMETER_STOP_FENCE", "0") == "1"
        ids = self.prompt_ids(messages)
        n_in = ids.shape[1]
        cached = features == "cached"
        t0 = time.time()
        out = self.model.generate(
            input_ids=ids,
            attention_mask=torch.ones_like(ids),
            max_new_tokens=max_new_tokens,
            do_sample=False,
            pad_token_id=self.tok.pad_token_id or self.tok.eos_token_id,
            return_dict_in_generate=cached,
            stopping_criteria=StoppingCriteriaList([FenceStop(self.tok, n_in)]) if stop_at_fence else None,
        )
        gen_seconds = time.time() - t0
        seqs = out.sequences if cached else out
        gen = seqs[0, n_in:].tolist()
        while gen and gen[-1] in self.stop_ids:
            gen.pop()
        if not gen:  # degenerate: model stopped immediately
            gen = seqs[0, n_in : n_in + 1].tolist()
        if cached and getattr(out, "past_key_values", None) is not None:
            return self._features_cached(ids, gen, gen_seconds, out.past_key_values)
        return self._features(ids, gen, gen_seconds)

    def _features_cached(self, ids: torch.Tensor, gen: list[int], gen_seconds: float, cache) -> Generation:
        """Same features as _features(), but the prompt (minus its last token) comes from generate()'s KV cache.
        Forward [last prompt token] + gen: hidden state 0 is the last prompt token, 1.. are the SQL tokens."""
        n_in = ids.shape[1]
        n_gen = len(gen)
        t1 = time.time()
        extra = cache.get_seq_length() - (n_in - 1)  # cache holds prompt + all but the last generated token
        if extra > 0:
            cache.crop(-extra)  # negative = drop that many tokens (works on old and new transformers)
        tail = torch.tensor([[int(ids[0, -1])] + gen], device=self.device)
        pos = torch.arange(n_in - 1, n_in + n_gen, device=self.device)
        fw = self.model(tail, past_key_values=cache, use_cache=True, output_hidden_states=True,
                        attention_mask=torch.ones(1, n_in + n_gen, dtype=torch.long, device=self.device),
                        position_ids=pos[None], cache_position=pos)
        logits = fw.logits[0, :-1].float()  # position j predicts gen[j]
        lp = torch.log_softmax(logits, dim=-1).gather(1, torch.tensor(gen, device=self.device)[:, None])[:, 0]
        hs = torch.stack([h[0] for h in fw.hidden_states])  # (L+1, 1 + n_gen, d)
        feats = (hs[:, 0].half().cpu(), hs[:, -1].half().cpu(), hs[:, 1:].float().mean(dim=1).half().cpu())
        del fw, hs, cache
        return self._pack(gen, n_in, lp, feats, gen_seconds, time.time() - t1)

    @torch.no_grad()
    def score_given(self, messages: list[dict[str, str]], sql: str, raw: str | None = None) -> Generation:
        """Teacher-force someone else's SQL as this model's answer and return the same features generate() would.

        The response text is the SQL inside the same ```sql fence the model emits (or `raw` verbatim), tokenized
        without special tokens, so a model's own decoded output reproduces generate()'s features."""
        ids = self.prompt_ids(messages)
        text = raw if raw is not None else f"```sql\n{sql.strip()}\n```"
        gen = self.tok(text, add_special_tokens=False).input_ids or [self.tok.eos_token_id]
        return self._features(ids, gen, 0.0)

    def _features(self, ids: torch.Tensor, gen: list[int], gen_seconds: float) -> Generation:
        n_in = ids.shape[1]
        n_gen = len(gen)
        seq = torch.tensor([ids[0].tolist() + gen], device=self.device)

        # One forward pass: hidden states at every layer + logits for generated positions only.
        t1 = time.time()
        fw = self.model(seq, output_hidden_states=True, logits_to_keep=n_gen + 1)
        logits = fw.logits[0, :-1].float()  # predicts gen tokens
        lp = torch.log_softmax(logits, dim=-1).gather(1, torch.tensor(gen, device=self.device)[:, None])[:, 0]
        hs = torch.stack([h[0] for h in fw.hidden_states])  # (L+1, T, d)
        feats = (
            hs[:, n_in - 1].half().cpu(),
            hs[:, -1].half().cpu(),
            hs[:, n_in:].float().mean(dim=1).half().cpu(),
        )
        del fw, hs
        return self._pack(gen, n_in, lp, feats, gen_seconds, time.time() - t1)

    def _pack(self, gen: list[int], n_in: int, lp: torch.Tensor, feats: tuple, gen_seconds: float,
              feat_seconds: float) -> Generation:
        n_gen = len(gen)
        raw = self.tok.decode(gen, skip_special_tokens=True)
        lp_list = lp.cpu().tolist()
        return Generation(
            raw=raw,
            sql=extract_sql(raw),
            n_prompt=n_in,
            n_gen=n_gen,
            logprob_mean=float(sum(lp_list) / len(lp_list)),
            logprob_min=float(min(lp_list)),
            gen_seconds=gen_seconds,
            feat_seconds=feat_seconds,
            hs_last_prompt=feats[0],
            hs_last_gen=feats[1],
            hs_mean_gen=feats[2],
            token_logprobs=lp_list,
            tokens=self.tok.convert_ids_to_tokens(gen),
        )

    @torch.no_grad()
    def sample(
        self,
        messages: list[dict[str, str]],
        n: int = 6,
        temperature: float = 0.8,
        top_p: float = 0.95,
        max_new_tokens: int = DEFAULT_MAX_NEW_TOKENS,
        seed: int | None = None,
        vram_budget_bytes: int = SAMPLE_VRAM_BUDGET,
    ) -> list[str]:
        """n sampled SQL strings (for two-readings). Separate from generate(); probe features are unaffected.

        The prompt is prefilled once and its KV cache is shared by all samples (repeated per row), so
        cost ~ one prefill + n-way batched decode. Batch size shrinks if the KV estimate would exceed the
        VRAM budget, and halves again on CUDA OOM.
        """
        import copy

        from transformers import DynamicCache

        if seed is not None:
            torch.manual_seed(seed)
            torch.cuda.manual_seed_all(seed)
        ids = self.prompt_ids(messages)
        n_in = ids.shape[1]
        # Prefill everything but the last prompt token; generate() feeds that token itself.
        prefix = DynamicCache(config=self.model.config)
        self.model(ids[:, :-1], past_key_values=prefix, use_cache=True, logits_to_keep=1)

        cfg = self.model.config
        head_dim = getattr(cfg, "head_dim", None) or cfg.hidden_size // cfg.num_attention_heads
        kv_per_seq = 2 * cfg.num_hidden_layers * cfg.num_key_value_heads * head_dim * 2 * (n_in + max_new_tokens)
        headroom = vram_budget_bytes - torch.cuda.memory_allocated(self.device) - SAMPLE_ACT_MARGIN
        batch = max(1, min(n, headroom // max(kv_per_seq, 1)))
        self.last_sample_batch = batch

        sqls: list[str] = []
        while len(sqls) < n:
            b = min(batch, n - len(sqls))
            cache = None
            try:
                cache = copy.deepcopy(prefix)
                if b > 1:
                    cache.batch_repeat_interleave(b)
                out = self.model.generate(
                    input_ids=ids.repeat(b, 1),
                    attention_mask=torch.ones(b, n_in, dtype=torch.long, device=self.device),
                    past_key_values=cache,
                    max_new_tokens=max_new_tokens,
                    do_sample=True,
                    temperature=temperature,
                    top_p=top_p,
                    top_k=0,
                    pad_token_id=self.tok.pad_token_id or self.tok.eos_token_id,
                )
            except torch.cuda.OutOfMemoryError:
                del cache
                torch.cuda.empty_cache()
                if b == 1:
                    raise
                batch = max(1, b // 2)
                self.last_sample_batch = batch
                continue
            for row in out[:, n_in:].tolist():
                while row and row[-1] in self.stop_ids:
                    row.pop()
                sqls.append(extract_sql(self.tok.decode(row, skip_special_tokens=True)))
            del out, cache
        del prefix
        return sqls
