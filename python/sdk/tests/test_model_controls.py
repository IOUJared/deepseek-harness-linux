from __future__ import annotations

from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness, DeepSeekHarnessConfig, HarnessClient, HarnessConfig
from deepseek_harness.models import InitializeResponse


@pytest.mark.parametrize("tier", ["default", "priority"])
@pytest.mark.parametrize("verbosity", ["low", "medium", "high"])
def test_selected_controls_forward_from_constructor_to_initialize(tier, verbosity, monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(HarnessClient, "start", lambda self: None)
    monkeypatch.setattr(HarnessClient, "close", lambda self: None)

    def request(self, method, payload, **kwargs):
        calls.append((method, payload))
        return InitializeResponse()

    monkeypatch.setattr(HarnessClient, "request", request)
    with DeepSeekHarness(service_tier=tier, text_verbosity=verbosity):
        pass
    assert calls == [("initialize", {
        "cwd": str(Path.cwd()),
        "provider": "deepseek-official",
        "model": "deepseek-v4-flash",
        "serviceTier": tier,
        "textVerbosity": verbosity,
    })]


def test_omitted_controls_preserve_initialize_json(monkeypatch) -> None:
    calls = []

    def request(self, method, payload, **kwargs):
        calls.append(payload)
        return InitializeResponse()

    monkeypatch.setattr(HarnessClient, "request", request)
    HarnessClient(HarnessConfig()).initialize(cwd=".", provider="p", model="m")
    assert calls == [{"cwd": str(Path.cwd()), "provider": "p", "model": "m"}]


@pytest.mark.parametrize("field,value", [
    ("service_tier", "auto"), ("service_tier", True), ("service_tier", []),
    ("text_verbosity", "verbose"), ("text_verbosity", 1), ("text_verbosity", {}),
])
def test_invalid_controls_reject_before_transport_or_runtime_launch(field, value, monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(HarnessClient, "request", lambda *args, **kwargs: calls.append(args))
    with pytest.raises(ValueError, match=field):
        DeepSeekHarnessConfig(**{field: value})
    with pytest.raises(ValueError, match=field):
        HarnessClient(HarnessConfig()).initialize(cwd=".", provider="p", model="m", **{field: value})
    assert calls == []
