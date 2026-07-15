import plistlib
import subprocess
from pathlib import Path


WORKER_DIRECTORY = Path(__file__).parents[1]
SERVICE_SCRIPT = WORKER_DIRECTORY / "scripts" / "service.sh"
RUNNER_SCRIPT = WORKER_DIRECTORY / "scripts" / "run-production-service.sh"
PLIST_TEMPLATE = WORKER_DIRECTORY / "launchd" / "com.koth-company.cv-worker.plist"


def test_service_shell_scripts_have_valid_syntax() -> None:
    for script in (SERVICE_SCRIPT, RUNNER_SCRIPT):
        result = subprocess.run(
            ["bash", "-n", str(script)],
            check=False,
            capture_output=True,
            text=True,
        )

        assert result.returncode == 0, result.stderr


def test_launchd_template_restarts_without_containing_secrets() -> None:
    template = PLIST_TEMPLATE.read_bytes()
    plist = plistlib.loads(template)

    assert plist["Label"] == "com.koth-company.cv-worker"
    assert plist["RunAtLoad"] is True
    assert plist["KeepAlive"] is True
    assert plist["ThrottleInterval"] == 15
    assert b"PREDICTION_CV_SECRET" not in template
    assert b".env.local" not in template


def test_production_runner_pins_remote_server_and_frozen_dependencies() -> None:
    runner = RUNNER_SCRIPT.read_text()

    assert 'readonly production_server_url="https://koth.company"' in runner
    assert 'export KOTH_SERVER_URL="$production_server_url"' in runner
    assert 'source "$environment_file"' in runner
    assert 'export UV_CACHE_DIR="$worker_directory/.uv-cache"' in runner
    assert "run --frozen koth-cv run --takeover" in runner


def test_service_help_is_read_only_and_documents_lifecycle_commands() -> None:
    result = subprocess.run(
        ["bash", str(SERVICE_SCRIPT), "help"],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    for command in ("install", "status", "logs", "restart", "uninstall"):
        assert command in result.stdout


def test_service_replaces_the_complete_launchd_argument_array() -> None:
    service = SERVICE_SCRIPT.read_text()

    assert "plutil -replace ProgramArguments -json" in service
    assert "ProgramArguments.0" not in service
    assert "ProgramArguments.1" not in service
