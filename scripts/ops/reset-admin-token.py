#!/usr/bin/env python3
"""Compatibility entry point for owner password recovery."""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).with_name("reset-admin-password.py")), run_name="__main__")
