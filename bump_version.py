#!/usr/bin/env python3
"""
bump_version.py - Update every mention of Sync-Player's version number.

The current version is read from res/package.json (the source of truth); the
new version is asked for interactively or passed as an argument.

How false positives are avoided:
  * package.json / package-lock.json are never regex-replaced. Only the
    project's own top-level "version" fields are changed, and the result is
    re-parsed to prove nothing else (e.g. a dependency that happens to be
    at the same version) was touched.
  * In every other text file, a match must be the exact version, not part of
    a bigger one: "112.0.0", "12.0.0.1", "1.12.0.0" and "^12.0.0" style
    dependency ranges do not count as sure matches.
  * A match is applied automatically only when the same line names the
    project ("Sync-Player", "syncplayer", "sync-player"). Every other match is
    shown with its line and you decide (y/N). With --yes they are skipped.
  * .git, node_modules, runtime data folders, license texts and binary files
    are never scanned.

Usage:
    python bump_version.py                     # asks for the new version
    python bump_version.py 12.1.0              # new version as argument
    python bump_version.py 12.1.0 --dry-run    # only show what would change
    python bump_version.py 12.1.0 --yes        # no prompts; unsure matches are skipped
    python bump_version.py 12.1.0 --from 12.0.0  # if res/package.json is out of sync
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PACKAGE_JSON = Path("res") / "package.json"

SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".vscode", ".idea",
    "memory", "media", "tracks", "sync-player-thumbnails", "public",
    "dist", "build", "out",
}
SKIP_FILES = {"LICENSE", "LICENSE.txt", "OFL.txt", "temp-files.txt", Path(__file__).name, "make_release.py"}
BINARY_EXTENSIONS = {
    ".zip", ".rar", ".7z", ".gz", ".tgz", ".ttf", ".otf", ".woff", ".woff2",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svgz", ".mp4", ".mkv",
    ".mp3", ".avi", ".mov", ".wmv", ".webm", ".wasm", ".db", ".sqlite",
    ".exe", ".dll", ".node", ".so", ".pem", ".key", ".crt", ".pyc",
}
JSON_MANIFESTS = {"package.json", "package-lock.json"}
MAX_FILE_SIZE = 5 * 1024 * 1024

PROJECT_KEYWORDS = re.compile(r"sync[-_ ]?player", re.IGNORECASE)
DEPENDENCY_PREFIX = re.compile(r"[\^~<>=]\s*v?$")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


def version_pattern(version: str) -> re.Pattern:
    """Exact version, optionally prefixed by a standalone 'v' (v12.0.0, -v12.0.0)."""
    escaped = re.escape(version)
    return re.compile(
        rf"(?:(?<=(?<![\w.])[vV])|(?<![\w.]))"  # start: after a lone 'v', or not inside a word/number
        rf"{escaped}"
        rf"(?![\w]|\.\d|-[0-9A-Za-z])"           # end: not followed by more digits, letters or a pre-release tag
    )


class Change:
    def __init__(self, rel_path, line_no, line, start, end, sure, reason):
        self.rel_path = rel_path
        self.line_no = line_no
        self.line = line
        self.start = start  # offsets into the whole file text
        self.end = end
        self.sure = sure
        self.reason = reason


# ----------------------------------------------------------------- file I/O --

def read_text(path: Path):
    """Return (text, had_bom) or None if the file is binary / not UTF-8."""
    try:
        if path.stat().st_size > MAX_FILE_SIZE:
            return None
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\x00" in raw[:8192]:
        return None
    had_bom = raw.startswith(b"\xef\xbb\xbf")
    try:
        return raw.decode("utf-8-sig" if had_bom else "utf-8"), had_bom
    except UnicodeDecodeError:
        return None


def write_text(path: Path, text: str, had_bom: bool) -> None:
    data = text.encode("utf-8")
    if had_bom:
        data = b"\xef\xbb\xbf" + data
    path.write_bytes(data)  # bytes -> line endings are preserved exactly


def iter_text_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if name in SKIP_FILES or path.suffix.lower() in BINARY_EXTENSIONS:
                continue
            yield path


# --------------------------------------------------------- JSON manifests --

def bump_json_manifest(path: Path, text: str, old: str, new: str):
    """Change only the project's own version fields. Returns (new_text, notes)."""
    notes = []
    try:
        data = json.loads(text)
    except ValueError as exc:
        return None, [f"skipped (invalid JSON: {exc})"]
    if not isinstance(data, dict):
        return None, []

    expected = json.loads(text)
    targets = []  # (description, regex, search_from)
    version_re = re.compile(r'("version"\s*:\s*")' + re.escape(old) + r'"')

    if data.get("version") == old:
        expected["version"] = new
        targets.append("top-level \"version\"")
    elif "version" in data:
        notes.append(f'top-level "version" is {data["version"]!r}, not {old!r} - left alone')

    root_pkg = data.get("packages", {}).get("") if path.name == "package-lock.json" else None
    if isinstance(root_pkg, dict):
        if root_pkg.get("version") == old:
            expected["packages"][""]["version"] = new
            targets.append('packages[""].version')
        elif "version" in root_pkg:
            notes.append(f'packages[""].version is {root_pkg["version"]!r} - left alone')

    if not targets:
        return None, notes

    new_text = text
    # Top-level "version": the occurrence with the smallest indentation.
    if "top-level \"version\"" in targets:
        candidates = list(re.finditer(r'^([ \t]*)"version"\s*:\s*"' + re.escape(old) + '"', new_text, re.M))
        if candidates:
            best = min(candidates, key=lambda m: len(m.group(1)))
            span = version_re.search(new_text, best.start())
            new_text = new_text[:span.start()] + span.group(1) + new + '"' + new_text[span.end():]
    # Lockfile root package: first "version" after the `"": {` entry.
    if 'packages[""].version' in targets:
        anchor = re.search(r'"packages"\s*:\s*\{\s*""\s*:\s*\{', new_text)
        if anchor:
            span = version_re.search(new_text, anchor.end())
            if span:
                new_text = new_text[:span.start()] + span.group(1) + new + '"' + new_text[span.end():]

    # Safety net: the only difference must be the fields we meant to change.
    try:
        if json.loads(new_text) != expected:
            return None, notes + ["skipped: could not change only the version field(s) safely - edit by hand"]
    except ValueError:
        return None, notes + ["skipped: edit would have produced invalid JSON - edit by hand"]
    notes.insert(0, "updated " + " and ".join(targets))
    return new_text, notes


# -------------------------------------------------------------- scanning --

def find_text_changes(rel_path: str, text: str, pattern: re.Pattern):
    changes = []
    line_starts = [0] + [m.end() for m in re.finditer(r"\n", text)]
    for match in pattern.finditer(text):
        # Locate the line containing the match.
        lo, hi = 0, len(line_starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if line_starts[mid] <= match.start():
                lo = mid
            else:
                hi = mid - 1
        line_start = line_starts[lo]
        line_end = text.find("\n", match.start())
        line = text[line_start: line_end if line_end != -1 else len(text)].rstrip("\r")
        before = text[line_start:match.start()]

        if DEPENDENCY_PREFIX.search(before):
            sure, reason = False, "looks like a dependency version range"
        elif PROJECT_KEYWORDS.search(line):
            sure, reason = True, "line mentions Sync-Player"
        else:
            sure, reason = False, "line does not mention Sync-Player"
        changes.append(Change(rel_path, lo + 1, line, match.start(), match.end(), sure, reason))
    return changes


def highlight(change: Change, text: str) -> str:
    line_start = text.rfind("\n", 0, change.start) + 1
    col_start = change.start - line_start
    col_end = change.end - line_start
    line = change.line
    shown = line[:col_start] + ">>>" + line[col_start:col_end] + "<<<" + line[col_end:]
    shown = shown.strip()
    return shown if len(shown) <= 200 else shown[:197] + "..."


def ask(prompt: str, default_yes=False) -> bool:
    suffix = " [Y/n] " if default_yes else " [y/N] "
    try:
        answer = input(prompt + suffix).strip().lower()
    except EOFError:
        return default_yes
    return (answer in ("y", "yes")) or (default_yes and answer == "")


# ------------------------------------------------------------------ main --

def read_current_version(root: Path) -> str:
    pkg = root / PACKAGE_JSON
    try:
        return json.loads(pkg.read_text(encoding="utf-8-sig"))["version"]
    except (OSError, ValueError, KeyError) as exc:
        sys.exit(f"[ERROR] Could not read the current version from {pkg}: {exc}\n"
                 f"        Pass it explicitly with --from X.Y.Z")


def normalize_version(value: str) -> str:
    value = value.strip()
    if value[:1] in ("v", "V"):
        value = value[1:]
    if not SEMVER_RE.match(value):
        sys.exit(f"[ERROR] {value!r} is not a valid version (expected something like 12.1.0)")
    return value


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")

    parser = argparse.ArgumentParser(description="Update Sync-Player's version number everywhere.")
    parser.add_argument("new_version", nargs="?", help="new version, e.g. 12.1.0 (asked if omitted)")
    parser.add_argument("--from", dest="old_version", help="current version (default: read from res/package.json)")
    parser.add_argument("--dry-run", action="store_true", help="show the changes without writing anything")
    parser.add_argument("--yes", "-y", action="store_true",
                        help="don't ask anything: apply sure matches, skip unsure ones")
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)  # for testing
    args = parser.parse_args()
    root = args.root.resolve()

    old = normalize_version(args.old_version) if args.old_version else read_current_version(root)
    print(f"Current version: {old}")
    new_raw = args.new_version
    if not new_raw:
        try:
            new_raw = input("New version: ")
        except EOFError:
            new_raw = ""
    new = normalize_version(new_raw)
    if new == old:
        print("New version is the same as the current one - nothing to do.")
        return 0

    pattern = version_pattern(old)
    file_texts = {}       # rel_path -> (path, text, had_bom)
    json_updates = {}     # rel_path -> new_text
    text_changes = []

    print(f"\nScanning {root} for {old!r} ...\n")
    for path in iter_text_files(root):
        loaded = read_text(path)
        if loaded is None:
            continue
        text, had_bom = loaded
        rel = path.relative_to(root).as_posix()

        if path.name in JSON_MANIFESTS:
            new_text, notes = bump_json_manifest(path, text, old, new)
            for note in notes:
                print(f"  [json] {rel}: {note}")
            if new_text is not None:
                file_texts[rel] = (path, text, had_bom)
                json_updates[rel] = new_text
            continue

        if old not in text:
            continue
        found = find_text_changes(rel, text, pattern)
        if found:
            file_texts[rel] = (path, text, had_bom)
            text_changes.extend(found)

    sure = [c for c in text_changes if c.sure]
    unsure = [c for c in text_changes if not c.sure]

    if sure:
        print(f"\nSure matches ({len(sure)}):")
        for c in sure:
            print(f"  {c.rel_path}:{c.line_no}: {highlight(c, file_texts[c.rel_path][1])}")

    accepted_unsure = []
    if unsure:
        print(f"\nUnsure matches ({len(unsure)}) - possible false positives:")
        for c in unsure:
            print(f"\n  {c.rel_path}:{c.line_no}  ({c.reason})")
            print(f"    {highlight(c, file_texts[c.rel_path][1])}")
            if args.yes:
                print("    -> skipped (--yes)")
            elif args.dry_run:
                print("    -> would ask")
            elif ask("    Replace this one?"):
                accepted_unsure.append(c)

    to_apply = sure + accepted_unsure
    total = len(to_apply) + len(json_updates)
    if total == 0:
        print(f"\nNo mentions of {old} to update.")
        return 0

    files_touched = sorted({c.rel_path for c in to_apply} | set(json_updates))
    print(f"\n{total} change(s) in {len(files_touched)} file(s): {old} -> {new}")
    for rel in files_touched:
        print(f"  - {rel}")

    if args.dry_run:
        print("\nDry run - nothing was written.")
        return 0
    if not args.yes and not ask("\nApply these changes?"):
        print("Aborted - nothing was written.")
        return 1

    by_file = {}
    for c in to_apply:
        by_file.setdefault(c.rel_path, []).append(c)

    for rel in files_touched:
        path, text, had_bom = file_texts[rel]
        if rel in json_updates:
            text = json_updates[rel]
        else:
            for c in sorted(by_file.get(rel, []), key=lambda c: c.start, reverse=True):
                text = text[:c.start] + new + text[c.end:]
        write_text(path, text, had_bom)

    print(f"\nDone. Version is now {new}.")
    print("Next step for a release: python make_release.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
