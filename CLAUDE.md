# Altimeter (HackRPI 2026)

Local text-to-SQL that knows when its SQL is wrong before it runs. A probe on the model's hidden states sets a confidence "altitude". Low confidence shows two readings or escalates to the cloud with schema + question only (zero data rows).

Hackathon: Sat Nov 7 11:00 AM to Sun Nov 8 9:00 AM. Devpost due 8:30 AM target. All project code is written during the event.

## Working rules for Claude
- Be token-efficient: short replies, no recaps, edit files directly, don't re-read files you just wrote.
- Never invent results. Every number on a slide or in the UI comes from our own runs. Mark unmeasured values as [TBD].
- Prefer simple, working code over clever code. Ship the vertical slice first.
- Ask before adding dependencies or big refactors.
- Python 3.11, type hints, small modules. No notebooks in the final repo.

## Hardware and environment
- Demo laptop: Windows + WSL2 Ubuntu, RTX 4050 Laptop (6 GB VRAM). Keep plugged in (GPU throttles on battery).
- Training/labeling box: RTX 3060 (check 12 GB vs 6 GB).
- Venv: ~/hack. Model: ~/models/OmniSQL-7B. Data: ~/data (spider_data/, bird_minidev/, bird_dev/).
- Same stack on both GPUs: transformers + bitsandbytes 4-bit NF4 (bnb_4bit_compute_dtype=bfloat16), output_hidden_states=True. Pin identical library versions on both machines.
- Model: seeklhy/OmniSQL-7B (Qwen2 arch, 28 layers, d=3584). ~4.4-5 GB VRAM in 4-bit. Use max_new_tokens<=256, torch.cuda.empty_cache() after hooks.

## Data and labels
- Use ONLY held-out splits OmniSQL never trained on: BIRD dev / Mini-Dev and Spider dev. Never BIRD/Spider train (OmniSQL trained on them, labels would reflect memorization).
- Label = execution match: run predicted and gold SQL on SQLite, compare result sets (set equality, floats rounded to 4 dp). 10 s timeout (func_timeout) counts as wrong; log it. Flag empty==empty matches.
- BIRD gold has known errors (Mini-Dev audit: ~52.8% annotation errors; some join fan-out bugs in dev gold). Hand-check every example shown to judges. Keep an "audited clean" eval subset if time allows.

## ML recipe
1. Generate: greedy SQL for each question (OmniSQL prompt template, pruned DDL + 3 sample values per column). Optionally 4-6 samples at T=0.8 for two-readings.
2. Extract hidden states at layers ~14, 19, 24 for: (a) last prompt token, (b) mean over SQL tokens, (c) mean over critical SQL tokens (sqlglot: table/column names, join keys, filter literals, aggregates). Save to .pt.
3. Probes: logistic regression (standardize, PCA 256, L2) and a small MLP. Layer sweep. Final score = stacked logistic over probe + SQL-aware mean log-prob + min token log-prob + executes-or-not + table/join count, Platt-scaled.
4. Eval: GroupKFold by db_id (schema-disjoint). Bootstrap 95% CIs resampled by database.

## Baselines and controls (must report)
- Mean / min token log-prob (expect ~0.67 AUROC).
- Surface complexity logistic (question length, SQL length, #joins, #aggregates).
- Prompt-only probe (position (a)): if near final AUROC, reframe as "pre-flight risk".
- Shuffled-label control (~0.50).
- Random-init placebo: same probe on activations from an untrained Qwen2 model (expect ~0.6 from length/difficulty). Real probe must clearly beat it.
- Self-consistency (optional, offline only, 5x cost).

## Gates
- G1 (13:00): phone on router asks a question, gets SQL + result table (no probe).
- G2 (15:00): probe vs log-prob. If probe < log-prob + 0.02, ship stacked score and say honestly what the probe adds.
- G3 (19:00): end-to-end on 4050 under ~8 s/question. Else prune schema, fewer samples, or Qwen2.5-Coder-3B (disclose).
- G4 (by ~23:00): fan-out auditor catches the hero example.
- Feature freeze 04:00. Backup video recorded by 06:00.

## Fan-out auditor (deterministic, not ML)
- If SQL has JOIN + aggregate (SUM/AVG/COUNT without DISTINCT): check PRAGMA foreign_key_list / index_list; run SELECT COUNT(*), COUNT(DISTINCT key) on the join to detect row multiplication. On fan-out, flag and offer a CTE pre-aggregated rewrite.
- Hero candidate: BIRD dev #571 (codebase_community, user 24 posts vs votes; reported 3 x 8 fan-out, gold 3.0 vs true 0.375). VERIFY by running both queries before using it. Also check what OmniSQL actually generates for it.

## Architecture
- Model worker (WSL2): loads model once, generates SQL, captures activations, scores probe. Talks to gateway via Unix socket / multiprocessing pipe. Optionally run inside `sudo unshare -n` so `ip addr` shows only loopback (proof it's local).
- Gateway (FastAPI): static UI + one WebSocket; single asyncio.Queue consumer; SQLite opened read-only, 5 s timeout, forced LIMIT 200; uploads (CSV/XLSX <=10 MB, 200k rows) -> pandas -> per-session in-memory SQLite, dropped after 15 min, never logged.
- Cloud escalation (opt-in tap only): send schema + question JSON to Gemini (MLH track), show exact payload and byte count, run returned SQL locally through the auditor. Cache a few responses for offline fallback.
- Networking: GL.iNet travel router, no WAN; laptop on Ethernet with fixed IP; QR points to http://<ip>:8000. WSL2 needs mirrored networking (.wslconfig networkingMode=mirrored) or netsh portproxy + firewall allow. Plain http = no service worker/wake lock; use Cache-Control. Fallbacks: laptop-only mode, then a labeled Cloudflare quick tunnel.
- GPU proof: nvidia-smi --query-gpu=power.draw,utilization.gpu --format=csv -lms 500.

## UI (phone, plain HTML + one JS file, no build step)
- Altimeter strip with 3 bands (Cruise / Caution / Ask) and the calibrated number ALWAYS visible. Honest climb: plane holds "awaiting probe" until the real score arrives.
- Boarding-pass answer card: question, SQL (always visible), result, confidence, bytes sent, local/cloud.
- Two readings: stacked A/B cards, differing SQL tokens highlighted, 3-row preview, one tap to choose. Shown only when probe is low AND samples disagree on execution results.
- Radio-the-tower sheet: exact payload, byte counter, "Stay local" / "Transmit".
- Only transform/opacity animations; no live blur; page < 1 MB; reconnect WebSocket on visibilitychange.
- Must not look AI-generated: Poppins (self-hosted woff2 in server/static/fonts, offline LAN), no pills/rounded-full chips or buttons, no filler microcopy/eyebrow labels/taglines/emoji, no gradient hero or glassmorphism. Every piece of text carries information.
- Table screen (laptop): The Catch (no-gauge answer flows into a slide vs Altimeter holding + truth reveal), ceiling slider over ~500 held-out questions (wrong answers shipped vs questions answered), one honest chart (AUROC vs baselines; optionally AUROC by token position).
- CUT: trivia game, glass-cockpit dashboard, token "bug" tinting, 2D scatter, audio by default, parallax extras.

## Demo (3 min)
1. Hook (human first): "AI tools give confident wrong numbers and nothing warns you. This one reads its own internals and warns you before the query runs."
2. Judge scans QR, asks an easy question: climbs to Cruise, answer + SQL.
3. Ambiguous/hard question: drops to Ask, two readings with different numbers, judge taps one.
4. The Catch on the laptop (hero example), then judge's phone can't reach google.com yet answers still arrive.
5. Ceiling slider + baseline chart for ML judges. Credit prior work (SQL confidence papers, LatentRefusal, Cactus Hybrid).
Answers to expect: "why not ChatGPT/Claude Enterprise?" Enterprise keeps data private but doesn't tell you when it's wrong; closed models can't be probed; Altimeter answers easy questions locally and calls the cloud only when the gauge says so.

## Tracks to enter
Best ML/DS, Best In the Clouds, Best AI, Databricks (log eval runs to MLflow if cheap), MLH Gemini.
