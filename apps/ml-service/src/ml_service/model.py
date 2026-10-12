"""The models and their artifacts.

  lstm      LSTM(n_features -> hidden, 1 layer) -> last hidden state -> dropout 0.2 ->
            linear -> logit of P(next bar up)
  logistic  the fourth baseline: one linear layer on the flattened window -> logit

An artifact is a state_dict (torch.save, loaded with weights_only=True) next to a JSON
manifest entry holding everything needed to rebuild the inputs: kind, hidden size,
window, the fold, and the scaler fitted on that fold's training period.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import torch
from torch import nn

from ml_service.features import N_FEATURES

Kind = Literal["lstm", "logistic"]
DROPOUT = 0.2


@dataclass(frozen=True)
class ModelConfig:
    kind: Kind
    window: int
    hidden: int = 0  # lstm only

    @property
    def name(self) -> str:
        return f"lstm-h{self.hidden}-w{self.window}" if self.kind == "lstm" else f"logistic-w{self.window}"


class DirectionLSTM(nn.Module):
    def __init__(self, hidden: int, n_features: int = N_FEATURES) -> None:
        super().__init__()
        self.lstm = nn.LSTM(input_size=n_features, hidden_size=hidden, num_layers=1, batch_first=True)
        self.dropout = nn.Dropout(DROPOUT)
        self.head = nn.Linear(hidden, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # (batch, window, features) -> (batch,)
        _, (h, _) = self.lstm(x)
        out: torch.Tensor = self.head(self.dropout(h[-1])).squeeze(-1)
        return out


class LogisticWindow(nn.Module):
    def __init__(self, window: int, n_features: int = N_FEATURES) -> None:
        super().__init__()
        self.linear = nn.Linear(window * n_features, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out: torch.Tensor = self.linear(x.flatten(1)).squeeze(-1)
        return out


def build(config: ModelConfig) -> nn.Module:
    if config.kind == "lstm":
        if config.hidden < 1:
            raise ValueError("an LSTM needs hidden >= 1")
        return DirectionLSTM(config.hidden)
    return LogisticWindow(config.window)


def save_state(model: nn.Module, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({k: v.detach().clone() for k, v in model.state_dict().items()}, path)


def load_model(config: ModelConfig, path: Path) -> nn.Module:
    model = build(config)
    state = torch.load(path, map_location="cpu", weights_only=True)
    model.load_state_dict(state, strict=True)
    model.eval()
    return model


def same_state(a: nn.Module, b: nn.Module) -> bool:
    """Exact equality of every state_dict tensor (names, shapes, dtypes and values)."""
    sa, sb = a.state_dict(), b.state_dict()
    return sa.keys() == sb.keys() and all(
        sa[k].dtype == sb[k].dtype and sa[k].shape == sb[k].shape and torch.equal(sa[k], sb[k]) for k in sa
    )
