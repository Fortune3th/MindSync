#!/usr/bin/env python3
"""Recover the single owner through NAS terminal access without rewriting credentials."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unicodedata

class ResetError(Exception):
    pass

ASSIGNMENT = re.compile(rb"^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=")


def select_env(root, library=None, env_file=None):
    if env_file:
        path = Path(env_file).absolute()
    elif library:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", library):
            raise ResetError("Invalid library name.")
        path = root / "library" / (library + ".env")
    else:
        candidates = sorted(p for p in (root / "library").glob("*.env") if p.name != "example.env")
        if len(candidates) > 1:
            raise ResetError("Multiple libraries found. Select one with --library NAME.")
        path = candidates[0] if candidates else root / ".env"
    if path.is_symlink() or not path.is_file():
        raise ResetError("Library environment file was not found or is a symbolic link.")
    return path

def project_name(original):
    values = []
    for line in original.splitlines():
        match = ASSIGNMENT.match(line)
        if match and match[1] == b"MINDSYNC_PROJECT":
            value = line[match.end():].decode("ascii").strip()
            if value[:1] in ("'", '"') and value[-1:] == value[:1]:
                value = value[1:-1]
            values.append(value)
    if len(values) > 1 or (values and not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", values[0])):
        raise ResetError("Invalid MINDSYNC_PROJECT assignment.")
    return values[0] if values else "mindsync"



def validate_password(password):
    if not (12 <= len(password) <= 128 and re.search(r"[a-z]", password)
            and re.search(r"[A-Z]", password) and re.search(r"[0-9]", password)
            and re.search(r"[!-/:-@\[-`{-~]", password)
            and not any(unicodedata.category(c) == "Cc" for c in password)):
        raise ResetError("Use 12-128 characters including lowercase, uppercase, a number, and a special character.")


def reset(root, env_path, email, password, development=False):
    validate_password(password)
    if not re.fullmatch(r"[^\s<>@]+@[^\s<>@]+", email) or len(email) > 254:
        raise ResetError("Enter a valid email address.")
    original = env_path.read_bytes()
    project = "mindsync-dev" if development else project_name(original)
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith("MINDSYNC_") and key not in ("DATABASE_URL", "POSTGRES_PASSWORD", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME")}
    command = ["docker", "compose", "-p", project, "--env-file", str(env_path)]
    if development:
        command += ["-f", str(root / "dev" / "compose.yaml")]
    command += ["exec", "-T", "backend" if development else "mindsync", "/cargo-target/debug/mindsync-server" if development else "/usr/local/bin/mindsync-server", "--recover-owner"]
    payload = json.dumps({"email": email, "password": password, "confirmation": password}).encode()
    try:
        result = subprocess.run(command, input=payload, cwd=root, env=environment, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ResetError("Recovery could not complete. Check Docker and server availability; environment files were preserved.") from error
    if result.returncode:
        raise ResetError("Recovery failed. Check the running image supports --recover-owner and the database is available. Environment files were preserved.")
    if env_path.read_bytes() != original:
        raise ResetError("The environment file changed concurrently; review it before continuing.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library")
    parser.add_argument("--env-file")
    parser.add_argument("--development", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent.parent
    try:
        env = root / "dev" / "development.env" if args.development else select_env(root, args.library, args.env_file)
        email = input("Owner email (this becomes the recovery mailbox): ").strip()
        password = getpass.getpass("New password: ")
        if password != getpass.getpass("Confirm password: "):
            raise ResetError("Passwords do not match.")
        reset(root, env, email, password, args.development)
        print("Password updated. All administrator sessions revoked. Device tokens and library data preserved.")
    except (ResetError, EOFError, KeyboardInterrupt) as error:
        print(str(error) or "Recovery cancelled.", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
