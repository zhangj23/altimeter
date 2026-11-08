"""Schema rendering and the prompt template. Shared by labeling and serving so prompts match exactly."""
from __future__ import annotations

import re
import sqlite3
from functools import lru_cache

TEMPLATE = """Task Overview:
You are a data science expert. Below, you are provided with a database schema and a natural language question. Your task is to understand the schema and generate a valid SQL query to answer the question.

Database Engine:
SQLite

Database Schema:
{schema}
This schema describes the database's structure, including tables, columns, primary keys, foreign keys, and any relevant relationships or constraints.

Question:
{question}

Instructions:
- Make sure you only output the information that is asked in the question. If the question asks for a specific column, make sure to only include that column in the SELECT clause, nothing more.
- The generated query should return all of the information asked in the question without any missing or extra information.
- Output only the SQL query. Do not explain your reasoning.

Output Format:
In your answer, please enclose the generated SQL query in a code block:
```sql
-- Your SQL query
```"""

N_SAMPLE_VALUES = 3
MAX_VALUE_CHARS = 40
# Largest BIRD dev schema (european_football_2) renders to ~19.3k chars (~6.9k tokens). Longer schemas (wide
# uploads) are refused before generation: they would OOM or time out the 6 GB GPU and force a worker restart.
MAX_SCHEMA_CHARS = 24_000


def _qi(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


@lru_cache(maxsize=64)
def schema_text(db_path: str) -> str:
    """CREATE TABLE statements plus up to 3 distinct sample values per column, as SQL comments."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        out: list[str] = []
        tables = con.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
        ).fetchall()
        for name, ddl in tables:
            out.append((ddl or "").strip() + ";")
            for col in [r[1] for r in con.execute(f"PRAGMA table_info({_qi(name)})")]:
                try:
                    vals = [
                        str(r[0])[:MAX_VALUE_CHARS]
                        for r in con.execute(
                            f"SELECT DISTINCT {_qi(col)} FROM {_qi(name)} WHERE {_qi(col)} IS NOT NULL "
                            f"LIMIT {N_SAMPLE_VALUES}"
                        )
                    ]
                except sqlite3.Error:
                    vals = []
                out.append(f"-- {name}.{col} examples: {vals}")
        return "\n".join(out)
    finally:
        con.close()


def build_messages(db_path: str, question: str, evidence: str | None = None) -> list[dict[str, str]]:
    q = question.strip()
    if evidence and evidence.strip():
        q += "\n" + evidence.strip()
    return [{"role": "user", "content": TEMPLATE.format(schema=schema_text(db_path), question=q)}]


_FENCE = re.compile(r"```(?:sql)?\s*(.*?)```", re.S | re.I)


def extract_sql(text: str) -> str:
    """Last fenced code block; falls back to the raw text (minus an unclosed fence)."""
    blocks = _FENCE.findall(text)
    if blocks:
        return blocks[-1].strip()
    return re.sub(r"^```(?:sql)?", "", text.strip(), flags=re.I).strip()
