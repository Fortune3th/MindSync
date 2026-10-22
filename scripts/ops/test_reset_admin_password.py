"""Verify terminal recovery keeps owner files and secrets out of command arguments."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("recovery", Path(__file__).with_name("reset-admin-password.py"))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
PASSWORD = "Password with $ and \"1!"
ORIGINAL = b"# Owner configuration\r\nMINDSYNC_ADMIN_TOKEN=original-token\r\nPOSTGRES_PASSWORD=keep-value\r\nMINDSYNC_DATA_DIR=/owner/notes\r\nMINDSYNC_PROJECT=mindsync\r\n"

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "library").mkdir()
        self.env = self.root / "library" / "obsidian.env"
        self.env.write_bytes(ORIGINAL)

    def test_selects_library_without_overwriting_root_credentials(self):
        (self.root / ".env").write_text("obsolete")
        self.assertEqual(recovery.select_env(self.root), self.env)
        (self.root / "library" / "other.env").touch()
        with self.assertRaises(recovery.ResetError): recovery.select_env(self.root)
        self.assertEqual(recovery.select_env(self.root, library="obsidian"), self.env)

    def test_password_policy_accepts_special_characters_without_shell_escaping(self):
        recovery.validate_password(PASSWORD)
        for value in ("short", "lowercase123!", "UPPERCASE123!", "NoSymbols12345", "NoNumbersHere!", "ValidPassword1!\n"):
            with self.assertRaises(recovery.ResetError): recovery.validate_password(value)

    def test_recovery_uses_stdin_and_never_rewrites_environment(self):
        with patch.object(recovery.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")) as run:
            recovery.reset(self.root, self.env, "owner@example.com", PASSWORD)
        command = run.call_args.args[0]
        kwargs = run.call_args.kwargs
        self.assertNotIn(PASSWORD, " ".join(command))
        self.assertEqual(json.loads(kwargs["input"])["password"], PASSWORD)
        self.assertIn("--recover-owner", command)
        self.assertIn("exec", command)
        self.assertNotIn("down", command)
        self.assertEqual(self.env.read_bytes(), ORIGINAL)
        self.assertNotIn("MINDSYNC_ADMIN_PASSWORD", kwargs["env"])

    def test_failure_preserves_credentials_and_redacts_diagnostics(self):
        with patch.object(recovery.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b"", b"private-secret")):
            with self.assertRaises(recovery.ResetError) as error:
                recovery.reset(self.root, self.env, "owner@example.com", PASSWORD)
        self.assertNotIn("private-secret", str(error.exception))
        self.assertEqual(self.env.read_bytes(), ORIGINAL)

    def test_development_uses_its_own_compose_and_backend(self):
        with patch.object(recovery.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")) as run:
            recovery.reset(self.root, self.env, "owner@example.com", PASSWORD, True)
        command = run.call_args.args[0]
        self.assertIn("mindsync-dev", command)
        self.assertIn(str(self.root / "dev" / "compose.yaml"), command)
        self.assertIn("backend", command)

if __name__ == "__main__": unittest.main()
