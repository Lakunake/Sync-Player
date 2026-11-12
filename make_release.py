#!/usr/bin/env python3
"""
make_release.py - Build the Windows and Linux release zips for Sync-Player.

Output (by default in the project root, where *.zip is gitignored):
    windows.syncplayer-v<version>.zip
    linux.syncplayer-v<version>.zip

<version> is read from res/package.json, so run bump_version.py first when
you are releasing a new version.

The file layout mirrors the hand-made v12.0.0 release zips:
  * README.md is shipped as DOCS/README.md
  * LICENSE   is shipped as LICENSE.txt
  * only the Gandhi Sans fonts (+ their license texts) are shipped, no Arial
  * Linux zip gets start.sh + cert/generate-ssl.sh
  * Windows zip gets run.bat, legacylauncher.bat, console.ps1, launcher.vbs,
    generate-ssl.ps1 and cert/generate-ssl.bat

Safety fixes applied to the copies inside the zip (files on disk are NOT touched):
  * .sh files are converted to LF line endings and marked executable (CRLF
    shell scripts fail on Linux with "$'\\r': command not found").
  * .bat/.ps1/.vbs files are converted to CRLF line endings.
  * config.env is sanitized: the FFmpeg tools password, the player key and
    any machine-specific SSL cert paths are reset to release defaults.
    Use --keep-config to ship config.env exactly as it is on disk.

Usage:
    python make_release.py                  # build both zips
    python make_release.py --only linux     # build only one platform
    python make_release.py --out dist       # write zips somewhere else
    python make_release.py --list           # show what would be packed, write nothing
    python make_release.py --keep-config    # do not sanitize config.env
"""

import argparse
import json
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_OUT_DIR = ROOT
ZIP_NAME = "{platform}.syncplayer-v{version}.zip"

# --------------------------------------------------------------------------
# Manifest: (source, name inside the zip)
#   * source may contain glob wildcards (name inside zip must then be None)
#   * source may be a tuple of candidates; the first one that exists is used
#   * name None = same relative path as the source
# --------------------------------------------------------------------------
COMMON_FILES = [
    ("README.md", "DOCS/README.md"),
    (("LICENSE", "LICENSE.txt"), "LICENSE.txt"),
    ("DOCS/PrivacyPolicy.md", None),
    ("DOCS/TERMS_OF_SERVICE.md", None),
    ("config.env", None),
    ("res/admin.html", None),
    ("res/css/*.css", None),
    ("res/font/*.otf", None),
    ("res/font/*.txt", None),
    ("res/index.html", None),
    ("res/js/*.js", None),
    ("res/landing.html", None),
    ("res/lib/*.js", None),
    ("res/package.json", None),
    ("res/package-lock.json", None),
    ("res/postinstall.js", None),
    ("res/audit.js", None),
    ("res/.patched-advisories.json", None),
    ("res/server.js", None),
]

PLATFORM_FILES = {
    "linux": [
        ("start.sh", None),
        ("cert/generate-ssl.sh", None),
    ],
    "windows": [
        ("cert/generate-ssl.bat", None),
        ("legacylauncher.bat", None),
        ("run.bat", None),
        ("res/console.ps1", None),
        ("res/generate-ssl.ps1", None),
        ("res/launcher.vbs", None),
    ],
}

LF_EXTENSIONS = {".sh"}
CRLF_EXTENSIONS = {".bat", ".cmd", ".ps1", ".vbs"}
EXECUTABLE_EXTENSIONS = {".sh"}

# Values config.env must have inside a public release zip.
CONFIG_RELEASE_DEFAULTS = {
    "SYNC_PORT": "3000",
    "SYNC_USE_HTTPS": "true",
    "SYNC_SSL_KEY_FILE": "cert/cert.key",
    "SYNC_SSL_CERT_FILE": "cert/cert.crt",
    "SYNC_VOLUME_STEP": "5",
    "SYNC_MAX_VOLUME": "400",
    "SYNC_SKIP_SECONDS": "5",
    "SYNC_SKIP_INTRO_SECONDS": "87",
    "SYNC_VIDEO_AUTOPLAY": "false",
    "SYNC_JOIN_MODE": "sync",
    "SYNC_CLIENT_CONTROLS_DISABLED": "false",
    "SYNC_CLIENT_SYNC_DISABLED": "false",
    "SYNC_BSL_MODE": "any",
    "SYNC_BSL_ADVANCED_MATCH": "true",
    "SYNC_BSL_MATCH_THRESHOLD": "1",
    "SYNC_FFMPEG_DISABLE_BAN": "false",
    "SYNC_FFMPEG_DISABLE_CONSEQUENCES": "false",
    "SYNC_ADMIN_FINGERPRINT_LOCK": "false",
    "SYNC_PLAYER_KEY": "",
    "SYNC_CHAT_ENABLED": "true",
    "SYNC_SERVER_MODE": "false",
    "SYNC_DATA_HYDRATION": "true",
    "SYNC_FFMPEG_TOOLS_PASSWORD": "",
    "SYNC_SUBTITLE_RENDERER": "jassub",
    "SYNC_SUBTITLE_FIT": "bottom",
    "SYNC_SHOW_SSL_TIP": "true",
    "SYNC_SKIP_FIREWALL_CHECK": "false",
}
SECRET_CONFIG_KEYS = {"SYNC_FFMPEG_TOOLS_PASSWORD", "SYNC_PLAYER_KEY"}

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


class ReleaseError(Exception):
    pass


def read_version() -> str:
    pkg = ROOT / "res" / "package.json"
    try:
        version = json.loads(pkg.read_text(encoding="utf-8-sig"))["version"]
    except (OSError, ValueError, KeyError) as exc:
        raise ReleaseError(f"Could not read version from {pkg}: {exc}") from exc
    if not SEMVER_RE.match(version):
        raise ReleaseError(f"Version in res/package.json looks invalid: {version!r}")
    return version


def lockfile_warnings() -> list:
    """Compare res/package-lock.json against res/package.json; return human-readable problems."""
    problems = []
    try:
        pkg = json.loads((ROOT / "res" / "package.json").read_text(encoding="utf-8-sig"))
        lock = json.loads((ROOT / "res" / "package-lock.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        return [f"could not compare package-lock.json with package.json: {exc}"]

    root = lock.get("packages", {}).get("", {})
    if lock.get("version") != pkg.get("version") or root.get("version") != pkg.get("version"):
        problems.append(f"lockfile version is {lock.get('version')!r}, package.json is {pkg.get('version')!r}")
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        want, have = pkg.get(section, {}), root.get(section, {})
        if want != have:
            diff = sorted(set(want) ^ set(have)) or sorted(k for k in want if want[k] != have.get(k))
            problems.append(f"{section} differ from package.json: {', '.join(diff)}")
    return problems


def resolve_manifest(entries):
    """Expand globs/candidates into an ordered list of (Path, arcname)."""
    resolved = []
    seen = set()
    for source, arcname in entries:
        if isinstance(source, tuple):
            existing = [s for s in source if (ROOT / s).is_file()]
            if not existing:
                raise ReleaseError(f"None of these files exist: {', '.join(source)}")
            matches = [(ROOT / existing[0], arcname or existing[0])]
        elif any(ch in source for ch in "*?["):
            paths = sorted(p for p in ROOT.glob(source) if p.is_file())
            if not paths:
                raise ReleaseError(f"Pattern matched no files: {source}")
            matches = [(p, p.relative_to(ROOT).as_posix()) for p in paths]
        else:
            path = ROOT / source
            if not path.is_file():
                raise ReleaseError(f"Required file is missing: {source}")
            matches = [(path, arcname or source)]

        for path, name in matches:
            if name not in seen:
                seen.add(name)
                resolved.append((path, name))
    return resolved


def convert_line_endings(data: bytes, ext: str) -> bytes:
    if ext in LF_EXTENSIONS:
        return data.replace(b"\r\n", b"\n")
    if ext in CRLF_EXTENSIONS:
        return data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    return data


GITHUB_BLOB = "https://github.com/Lakunake/Sync-Player/blob/main"

# README.md lives in the repo root but is shipped as DOCS/README.md, so its
# relative links must be re-pointed (order matters: longest prefixes first).
README_LINK_REWRITES = [
    ("](DOCS/FAQ.md)", f"]({GITHUB_BLOB}/DOCS/FAQ.md)"),  # FAQ is not shipped in the zip
    ("](DOCS/", "]("),
    ("](DOCS)", "](.)"),
    ("](LICENSE)", "](../LICENSE.txt)"),
    ("](res/package.json)", "](../res/package.json)"),
]


def rewrite_readme_links(data: bytes, notes: list) -> bytes:
    text = data.decode("utf-8-sig")
    for old, new in README_LINK_REWRITES:
        if old in text:
            text = text.replace(old, new)
            notes.append(f"DOCS/README.md: link {old[2:-1]} -> {new[2:-1]}")
    return text.encode("utf-8")


def sanitize_config(data: bytes, notes: list) -> bytes:
    text = data.decode("utf-8-sig")
    for key, default in CONFIG_RELEASE_DEFAULTS.items():
        pattern = re.compile(rf"^({re.escape(key)}[ \t]*=)([^\r\n]*)", re.MULTILINE)

        def repl(match, key=key, default=default):
            current = match.group(2).strip()
            if current == default:
                return match.group(0)
            shown = "<hidden secret>" if key in SECRET_CONFIG_KEYS else current
            notes.append(f"config.env: {key} reset ({shown} -> {default or '<empty>'})")
            return match.group(1) + default

        text = pattern.sub(repl, text)
    return text.encode("utf-8")


def build_zip(platform: str, version: str, out_dir: Path, keep_config: bool) -> Path:
    files = resolve_manifest(COMMON_FILES + PLATFORM_FILES[platform])
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / ZIP_NAME.format(platform=platform, version=version)
    notes = []

    # Write to a temporary file first so a failure never leaves a broken zip behind.
    fd, tmp_name = tempfile.mkstemp(suffix=".zip", dir=out_dir)
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp_name, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            for path, arcname in files:
                ext = path.suffix.lower()
                data = path.read_bytes()
                converted = convert_line_endings(data, ext)
                if converted != data:
                    notes.append(f"{arcname}: line endings -> {'LF' if ext in LF_EXTENSIONS else 'CRLF'}")
                data = converted
                if arcname == "config.env" and not keep_config:
                    data = sanitize_config(data, notes)
                if arcname == "DOCS/README.md":
                    data = rewrite_readme_links(data, notes)

                info = zipfile.ZipInfo.from_file(path, arcname)
                info.create_system = 3  # Unix, so unzip honours the permission bits below
                mode = 0o755 if ext in EXECUTABLE_EXTENSIONS else 0o644
                info.external_attr = (0o100000 | mode) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, data)

        if target.exists():
            target.unlink()
        os.replace(tmp_name, target)
    except BaseException:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
        raise

    size_kb = target.stat().st_size / 1024
    print(f"[OK] {target.relative_to(ROOT) if target.is_relative_to(ROOT) else target}"
          f"  ({len(files)} files, {size_kb:.1f} KB)")
    for note in notes:
        print(f"     - {note}")
    return target


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")

    parser = argparse.ArgumentParser(description="Build Sync-Player release zips.")
    parser.add_argument("--only", choices=sorted(PLATFORM_FILES), help="build only this platform")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR,
                        help="output folder (default: project root)")
    parser.add_argument("--list", action="store_true", help="only list the files that would be packed")
    parser.add_argument("--keep-config", action="store_true",
                        help="ship config.env as-is (skip password/cert-path sanitizing)")
    args = parser.parse_args()

    platforms = [args.only] if args.only else ["windows", "linux"]
    out_dir = args.out if args.out.is_absolute() else (Path.cwd() / args.out)

    try:
        version = read_version()
        print(f"Sync-Player version: {version}\n")
        lock_problems = lockfile_warnings()
        for problem in lock_problems:
            print(f"[WARN] res/package-lock.json is out of date: {problem}")
        if lock_problems:
            print("       (fix with: cd res && npm install --package-lock-only)\n")
        for platform in platforms:
            if args.list:
                name = ZIP_NAME.format(platform=platform, version=version)
                print(f"== {name}")
                for path, arcname in resolve_manifest(COMMON_FILES + PLATFORM_FILES[platform]):
                    print(f"   {arcname}")
                print()
            else:
                build_zip(platform, version, out_dir, args.keep_config)
    except ReleaseError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
