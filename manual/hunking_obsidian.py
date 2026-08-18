#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "ccl-chromium-reader @ git+https://github.com/cclgroupltd/ccl_chromium_reader.git@b51a01c913799f5af2735f964d4627275369e90e",
#   "ccl-simplesnappy    @ git+https://github.com/cclgroupltd/ccl_simplesnappy.git@3d085230baa8c46cf2090ebba29bf6e8eab31087",
#   "cramjam>=2.8",
# ]
# ///
"""
Hunking Obsidian — export Obsidian's local version history as unified diffs.

Obsidian's File Recovery plugin snapshots every note you edit. This script reads
those snapshots directly from disk and writes them as a Markdown file of diffs —
one section per note, newest first, with a per-day activity table at the top.
Feed the output to an LLM for a weekly review of what you worked on.

No plugins, Obsidian Sync, or GUI needed. Works on macOS while Obsidian is open.

Usage:
    ./hunking_obsidian.py --since 7 --net --out week.md
    ./hunking_obsidian.py --since 7 --format json --out week.json
    ./hunking_obsidian.py --since 7 --format patch --out - | hunk patch -
    ./hunking_obsidian.py --help
"""

from __future__ import annotations
import argparse
import difflib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unicodedata
import datetime as dt
from pathlib import Path
from collections import defaultdict

LEVELDB = "app_obsidian.md_0.indexeddb.leveldb"
BLOB = "app_obsidian.md_0.indexeddb.blob"
HEADING = re.compile(r"^\s{0,3}#{1,6}\s")
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def default_app_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/obsidian"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", Path.home())) / "obsidian"
    return Path.home() / ".config/obsidian"


def local(ms: float) -> dt.datetime:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).astimezone()


def iso(ms: float) -> str:
    return local(ms).strftime("%Y-%m-%d %H:%M:%S")


def vault_id_for(app_dir: Path, needle: str) -> str | None:
    cfg = app_dir / "obsidian.json"
    if not cfg.exists():
        return None
    for vid, meta in json.loads(cfg.read_text()).get("vaults", {}).items():
        if needle.lower() in meta.get("path", "").lower():
            return vid
    return None


def fast_snappy() -> str:
    """Give the LevelDB reader a native Snappy decompressor. Returns what it ended up with.

    Obsidian's snapshots live in a Chromium IndexedDB, which is a LevelDB whose blocks are
    Snappy-compressed. ccl_simplesnappy decompresses them in pure Python, walking the compressed
    stream a byte at a time through a BytesIO — correct, and about 96% of this script's runtime:
    profiled over a real 113 MB database, 51 of 100 seconds sat inside its decompress across 82
    million single-byte reads, to reach the handful of records from the window you asked for.

    cramjam is a Rust Snappy behind prebuilt wheels — no system library, no compiler — and
    ccl_leveldb calls `ccl_simplesnappy.decompress` by module attribute, so rebinding that one
    name reaches every call site. Measured on the same database: 24.55s → 0.86s, a 28.5x
    speedup, with the loaded snapshots comparing equal.

    Missing cramjam is not an error. The reader keeps its own decompressor and stays correct,
    only slow, so this is an accelerator and never a dependency.
    """
    try:
        import ccl_simplesnappy
        import cramjam
    except ImportError:
        return "pure-Python snappy"

    def decompress(buffer) -> bytes:
        # ccl_leveldb passes a BytesIO; the value path passes raw bytes. Both are raw Snappy
        # blocks with no stream framing, which is decompress_raw's format exactly.
        data = buffer.read() if hasattr(buffer, "read") else buffer
        return bytes(cramjam.snappy.decompress_raw(data))

    ccl_simplesnappy.decompress = decompress
    return "native snappy (cramjam)"


def load_snapshots(leveldb: Path, blob_dir: Path | None, vault_id: str | None):
    """Return ({path: [(ts_ms, text), ...] sorted asc}, unrecoverable_count)."""
    import ccl_simplesnappy
    fast_snappy()  # idempotent, so importers of this function get the speedup too
    from ccl_chromium_reader.ccl_chromium_indexeddb import (
        WrappedIndexDB,
        _le_varint_from_bytes,
    )
    from ccl_chromium_reader.serialization_formats import (
        ccl_v8_value_deserializer as v8d,
    )
    from ccl_chromium_reader.serialization_formats import (
        ccl_blink_value_deserializer as blinkd,
    )

    blink = blinkd.BlinkV8Deserializer()

    def parse_v8(body: bytes) -> dict | None:
        # V8 payload header is 0xff <version> 0x6f; scan past the variable-length Blink trailer.
        for i in range(min(len(body) - 2, 64)):
            if body[i] == 0xFF and body[i + 2] == 0x6F:
                try:
                    obj = v8d.Deserializer(
                        io.BytesIO(body[i:]), host_object_delegate=blink.read
                    ).read()
                    if (
                        isinstance(obj, dict)
                        and "path" in obj
                        and isinstance(obj.get("data"), str)
                    ):
                        return obj
                except Exception:
                    pass
        return None

    def decode(buf: bytes) -> dict | None:
        # Blink envelope: 0xff 0x11 <compression-byte> ...  0x02=Snappy, 0x01=external-blob-ref
        body = (
            ccl_simplesnappy.decompress(io.BytesIO(buf[3:]))
            if buf[2] == 0x02
            else buf[3:]
        )
        return parse_v8(body)

    db = WrappedIndexDB(
        str(leveldb), str(blob_dir) if blob_dir and blob_dir.exists() else None
    )
    snaps: dict[str, list] = defaultdict(list)
    unrecoverable = 0

    for dbid in db.database_ids:
        if not dbid.name.endswith("-backup"):
            continue
        if vault_id and not dbid.name.startswith(vault_id):
            continue

        wstore = db[dbid.dbid_no].get_object_store_by_name("backups")
        raw_db, store_id = wstore._raw_db, wstore.object_store_id
        deferred: list[tuple] = []

        for rec in raw_db.iterate_records(
            dbid.dbid_no,
            store_id,
            bad_deserializer_data_handler=lambda k, r: deferred.append((k, r)),
        ):
            v = rec.value
            if isinstance(v, dict) and "path" in v and isinstance(v.get("data"), str):
                snaps[v["path"]].append((float(v["ts"]), v["data"]))

        for key, raw in deferred:
            # Some records have a leading varint length-prefix before the Blink envelope.
            buf = (
                raw
                if raw[:2] == b"\xff\x11"
                else raw[len(_le_varint_from_bytes(raw)[1]) :]
            )
            obj = None

            if buf[:3] == b"\xff\x11\x02":
                obj = decode(buf)
            elif buf[:3] == b"\xff\x11\x01":
                # blob-ref layout: 3-byte header | varint(wrapped-size) | varint(blob-index)
                p = 3
                _, size_raw = _le_varint_from_bytes(buf[p:])
                p += len(size_raw)
                blob_idx, _ = _le_varint_from_bytes(buf[p:])
                try:
                    obj = decode(
                        raw_db.get_blob(
                            dbid.dbid_no, store_id, key.raw_key, blob_idx
                        ).read()
                    )
                except Exception:
                    pass  # blob has been GC'd — unrecoverable

            if obj:
                snaps[obj["path"]].append((float(obj["ts"]), obj["data"]))
            else:
                unrecoverable += 1

    for path in snaps:
        snaps[path].sort(key=lambda x: x[0])
    return snaps, unrecoverable


def sync_seconds(snaps: dict, threshold: int) -> set[int]:
    """Seconds where >= threshold distinct notes were captured — bulk sync, not live authoring."""
    by_sec: dict[int, set] = defaultdict(set)
    for path, versions in snaps.items():
        for ts, _ in versions:
            by_sec[int(ts // 1000)].add(path)
    return {sec for sec, paths in by_sec.items() if len(paths) >= threshold}


def heading_aware_diff(
    text_a: str, text_b: str, context: int, from_label: str, to_label: str
) -> str:
    lines_b = text_b.splitlines()
    out = []
    for line in difflib.unified_diff(
        text_a.splitlines(),
        lines_b,
        fromfile=from_label,
        tofile=to_label,
        lineterm="",
        n=context,
    ):
        if line.startswith("@@"):
            m = HUNK.match(line)
            if m:
                start = max(int(m.group(1)) - 1, 0)
                heading = next(
                    (
                        lines_b[i].strip()
                        for i in range(min(start, len(lines_b) - 1), -1, -1)
                        if HEADING.match(lines_b[i])
                    ),
                    "",
                )
                if heading:
                    line = f"{line} {heading}"
        out.append(line)
    return "\n".join(out)


def pair_volume(text_a: str, text_b: str) -> tuple[int, int]:
    add = rem = 0
    for line in difflib.unified_diff(
        text_a.splitlines(), text_b.splitlines(), lineterm="", n=0
    ):
        if line[:2] in ("--", "++") or line.startswith("@@"):
            continue
        if line.startswith("+"):
            add += len(line) - 1
        elif line.startswith("-"):
            rem += len(line) - 1
    return add, rem


def activity_table(snaps: dict, cutoff_ms: float, sync_secs: set[int]) -> str:
    days: dict[str, dict] = defaultdict(
        lambda: {"notes": set(), "edits": 0, "add": 0, "rem": 0, "hours": []}
    )
    for path, versions in snaps.items():
        for i, (ts, data) in enumerate(versions):
            if ts < cutoff_ms or int(ts // 1000) in sync_secs:
                continue
            d = days[local(ts).strftime("%Y-%m-%d")]
            d["notes"].add(path)
            d["edits"] += 1
            d["hours"].append(local(ts).hour)
            if i > 0:  # first-ever snapshot is a baseline capture, not volume authored that day
                add, rem = pair_volume(versions[i - 1][1], data)
                d["add"] += add
                d["rem"] += rem
    if not days:
        return "## Activity by day\n\n_no live (non-sync) edits in window._\n"
    rows = [
        "| Date | Notes | Edits | +chars | −chars | Active hrs | Late-night |",
        "|------|------:|------:|-------:|-------:|------------|:----------:|",
    ]
    for date in sorted(days):
        d = days[date]
        hrs = sorted(d["hours"])
        span = f"{hrs[0]:02d}:00–{hrs[-1]:02d}:59"
        late = "⚠️" if any(0 <= h < 6 for h in hrs) else ""
        rows.append(
            f"| {date} | {len(d['notes'])} | {d['edits']} | {d['add']} | {d['rem']} | {span} | {late} |"
        )
    return (
        "## Activity by day\n\n_(live edits only; bulk syncs excluded — see below)_\n\n"
        + "\n".join(rows)
        + "\n"
    )


def sync_summary(snaps: dict, cutoff_ms: float, sync_secs: set[int]) -> str:
    bursts: dict[int, set] = defaultdict(set)
    for path, versions in snaps.items():
        for ts, _ in versions:
            if ts >= cutoff_ms and int(ts // 1000) in sync_secs:
                bursts[int(ts // 1000)].add(path)
    if not bursts:
        return ""
    lines = [
        f"- {iso(sec * 1000)[:16]} — {len(paths)} notes captured together"
        for sec, paths in sorted(bursts.items())
    ]
    return (
        "## Sync events (bulk captures — excluded from metrics)\n\n"
        "_These notes changed elsewhere and synced in at one timestamp; their diffs "
        "still appear below but their timing is not real-time activity._\n\n"
        + "\n".join(lines)
        + "\n"
    )


def _norm_cmp(s: str) -> str:
    """Normalize away editor/sync noise (trailing whitespace, trailing blank lines, line endings,
    Unicode form) so a real edit can be told apart from an opened/auto-saved note. Change detection
    only — never used for the rendered diff."""
    lines = [ln.rstrip() for ln in s.splitlines()]
    while lines and lines[-1] == "":
        lines.pop()
    return unicodedata.normalize("NFC", "\n".join(lines))


def render(
    snaps: dict,
    cutoff_ms: float,
    context: int,
    net: bool,
    full_below: int,
    with_meta: bool,
    sync_secs: set[int],
    new_paths: set[str] | None = None,
) -> str:
    new_paths = new_paths or set()
    parts: list[str] = []
    total = sum(len(v) for v in snaps.values())
    parts.append(
        f"# Hunking Obsidian\n\n_generated {iso(dt.datetime.now().timestamp() * 1000)} · "
        f"{total} snapshots across {len(snaps)} notes_\n"
    )
    if with_meta:
        parts.append(activity_table(snaps, cutoff_ms, sync_secs))
        parts.append(sync_summary(snaps, cutoff_ms, sync_secs))

    ranked = sorted(
        ((p, v) for p, v in snaps.items() if v[-1][0] >= cutoff_ms),
        key=lambda kv: kv[1][-1][0],
        reverse=True,
    )

    for path, versions in ranked:
        in_win = [v for v in versions if v[0] >= cutoff_ms]
        pre = next((v for v in reversed(versions) if v[0] < cutoff_ms), None)
        head_ts, head_data = in_win[-1]
        edit_n = len(in_win)
        # One-line title; per-diff timestamps live in the diff's --- / +++ header rows.
        title = f"\n## {path} — {edit_n} edit{'' if edit_n == 1 else 's'} in window\n"

        if len(head_data) < full_below:
            parts.append(title)
            parts.append(
                "_current content:_\n\n```markdown\n" + head_data.rstrip() + "\n```\n"
            )
            continue

        # Baseline: last pre-window snapshot if we have one; otherwise the earliest in-window
        # snapshot — UNLESS the file was created within the window (new_paths), in which case it
        # is genuinely new and we diff against empty ("(new file)"). Opening/auto-saving/syncing
        # an old note makes an in-window snapshot with no real change; those diff empty and are
        # dropped below.
        NEW = "(new file)"
        if pre:
            base = (iso(pre[0]), pre[1])
        elif path in new_paths:
            base = (NEW, "")
        else:
            base = (iso(in_win[0][0]), in_win[0][1])
        if net:
            spans = [(base, (iso(head_ts), head_data))]
        else:
            tail = in_win if (pre or path in new_paths) else in_win[1:]
            chain = [base] + [(iso(ts), data) for ts, data in tail]
            spans = list(zip(chain, chain[1:]))

        body = []
        changed = False
        for (la, text_a), (lb, text_b) in spans:
            diff = heading_aware_diff(text_a, text_b, context, la, lb)
            # A change only counts if it survives whitespace/encoding normalization — a pure
            # whitespace rewrite (full delete + identical readd) is not a real edit.
            if diff and _norm_cmp(text_a) != _norm_cmp(text_b):
                changed = True
            body.append(f"```diff\n{diff or '(no textual change)'}\n```\n")
        if not changed:
            continue  # opened / auto-saved / synced but not actually edited → omit
        parts.append(title)
        parts.extend(body)

    return "\n".join(parts)


def render_patch(snaps: dict, cutoff_ms: float, context: int) -> str:
    """Emit a git-style multi-file unified diff (one section per note, baseline→newest).

    Feed to `hunk patch -`. The baseline is the last snapshot *before* the window if one
    exists (so the diff shows only what changed during the window); otherwise it falls back
    to the earliest in-window snapshot. This mirrors the markdown `--net` semantics and avoids
    falsely rendering a long-lived note as brand-new just because File Recovery only retained
    snapshots from inside the window. A genuinely new note still reads as additions, since its
    first captured snapshot is near-empty. Notes with no textual change are skipped so the
    viewer's sidebar stays clean.
    """
    ranked = sorted(
        ((p, v) for p, v in snaps.items() if v[-1][0] >= cutoff_ms),
        key=lambda kv: kv[1][-1][0],
        reverse=True,
    )
    parts: list[str] = []
    for path, versions in ranked:
        in_win = [v for v in versions if v[0] >= cutoff_ms]
        pre = next((v for v in reversed(versions) if v[0] < cutoff_ms), None)
        base = (pre or in_win[0])[1]
        new = in_win[-1][1]
        if base == new:
            continue
        # hunk derives its own @@ section heading, so use plain unified_diff (no
        # heading annotation) to avoid a doubled heading in the viewer.
        body = "\n".join(
            difflib.unified_diff(
                base.splitlines(),
                new.splitlines(),
                fromfile=f"a/{path}",
                tofile=f"b/{path}",
                lineterm="",
                n=context,
            )
        )
        parts.append(f"diff --git a/{path} b/{path}\n{body}")
    return "\n".join(parts) + ("\n" if parts else "")


def main() -> None:
    ap = argparse.ArgumentParser(description="Hunking Obsidian — LLM-ready version history.")
    ap.add_argument(
        "--app-dir", type=Path, help="Obsidian config dir (default: OS-specific)."
    )
    ap.add_argument("--leveldb", type=Path, help="Override path to the .leveldb dir.")
    ap.add_argument("--blob", type=Path, help="Override path to the .blob dir.")
    ap.add_argument("--vault", help="Limit to one vault by substring of its path.")
    ap.add_argument("--out", type=Path, default=Path("hunking-obsidian.md"))
    ap.add_argument("--format", choices=["md", "json", "patch"], default="md")
    ap.add_argument(
        "--since", type=int, default=0, help="Only the last N days (0 = all)."
    )
    ap.add_argument(
        "--context", type=int, default=3, help="Context lines per diff hunk."
    )
    ap.add_argument("--net", action="store_true", help="One first→last diff per note.")
    ap.add_argument(
        "--full-below",
        type=int,
        default=4000,
        help="Emit full content for notes whose newest version is under N chars.",
    )
    ap.add_argument(
        "--sync-threshold",
        type=int,
        default=4,
        help="Distinct notes in one second treated as a bulk sync (default 4).",
    )
    ap.add_argument(
        "--no-metadata",
        dest="metadata",
        action="store_false",
        help="Omit the per-day activity table.",
    )
    args = ap.parse_args()

    app_dir = args.app_dir or default_app_dir()
    leveldb = args.leveldb or app_dir / "IndexedDB" / LEVELDB
    blob_dir = args.blob or app_dir / "IndexedDB" / BLOB

    if not leveldb.exists():
        sys.exit(f"LevelDB not found: {leveldb}\nPass --app-dir or --leveldb.")

    vault_id = vault_id_for(app_dir, args.vault) if args.vault else None
    if args.vault and not vault_id:
        sys.exit(f"No vault matching {args.vault!r} in {app_dir / 'obsidian.json'}")

    codec = fast_snappy()
    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        shutil.copytree(leveldb, t / "l")
        if blob_dir.exists():
            shutil.copytree(blob_dir, t / "b")
        snaps, unrecoverable = load_snapshots(
            t / "l", t / "b" if blob_dir.exists() else None, vault_id
        )

    if not snaps:
        sys.exit("No snapshots found. Is the File recovery core plugin enabled?")

    cutoff_ms = (
        (dt.datetime.now() - dt.timedelta(days=args.since)).timestamp() * 1000
        if args.since
        else 0.0
    )
    gc_note = f" · {unrecoverable} unrecoverable (blob GC'd)" if unrecoverable else ""
    sync_secs = sync_seconds(snaps, args.sync_threshold)

    if args.format == "json":
        payload = {
            "generated": iso(dt.datetime.now().timestamp() * 1000),
            "since_days": args.since,
            "unrecoverable": unrecoverable,
            "snapshots": {
                p: [
                    {
                        "ts_ms": int(ts),
                        "ts": iso(ts),
                        "data": d,
                        "sync": int(ts // 1000) in sync_secs,
                    }
                    for ts, d in v
                    if ts >= cutoff_ms
                ]
                for p, v in snaps.items()
                if v[-1][0] >= cutoff_ms
            },
        }
        text = json.dumps(payload, indent=2, ensure_ascii=False)
    elif args.format == "patch":
        # patch mode is inherently net (one baseline→newest diff per note); --net is a no-op.
        text = render_patch(snaps, cutoff_ms, args.context)
    else:
        text = render(
            snaps,
            cutoff_ms,
            args.context,
            args.net,
            args.full_below,
            args.metadata,
            sync_secs,
        )

    if str(args.out) == "-":
        try:
            sys.stdout.write(text)
            sys.stdout.flush()
        except BrokenPipeError:
            # Reader closed early (e.g. `| head`, or quitting hunk) — exit quietly.
            os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
            return
    else:
        args.out.write_text(text)

    # Summary → stderr so it never contaminates a piped stream (e.g. `--out - | hunk patch -`).
    print(
        f"Wrote {args.out} — {len(snaps)} notes, since={args.since}d, net={args.net}, "
        f"sync_bursts={len(sync_secs)}{gc_note} · {codec}.",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
