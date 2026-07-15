from koth_cv.client import signed_headers


def test_signed_headers_match_server_contract() -> None:
    headers = signed_headers(
        secret="secret",
        method="POST",
        path="/api/predictions/automation/actions",
        body='{"type":"heartbeat"}',
        idempotency_key="arena-4-result",
        timestamp="1720000000000",
    )

    assert headers["x-cv-signature"] == (
        "7e59ecc1a6fa4c4139ffc925227cade8e235dc520755ffc41affef633262dcfa"
    )
