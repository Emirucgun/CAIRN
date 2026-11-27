import { describe, expect, it } from "vitest";
import { sk } from "./helpers.js";

const SRC = `"""Auth sessions."""
from __future__ import annotations

import os
import json as j, typing
from .tokens import Token, refresh
from . import errors
from ..core.db import (
    connect,
)

MAX_RETRIES: int = 3
_cache = {}
default_timeout = 30


# Creates a session.
@retry(times=3)
async def login(email: str, pw: str, *, remember: bool = False) -> "Session":
    """Log in."""
    return Session(email)


def _helper():
    import hashlib
    return hashlib


class Session(Base, metaclass=Meta):
    """A user session."""

    ttl: int = 60
    _secret = None

    def __init__(self, email: str) -> None:
        self.email = email

    @property
    def expired(self) -> bool:
        return False

    def _rotate(self):
        pass

    class Config:
        frozen = True


class _Internal:
    def visible(self):
        pass
`;

describe("python skeleton", () => {
  it("extracts functions, classes, methods, nested classes and module constants", async () => {
    expect((await sk("python", SRC)).symbols).toEqual([
      "+const MAX_RETRIES 12-12 | : int",
      "-variable _cache 13-13 | ",
      "+variable default_timeout 14-14 | ",
      '+function login 17-21 | (email: str, pw: str, *, remember: bool = False) -> "Session"',
      "-function _helper 24-26 | ()",
      "+class Session 29-46 | (Base, metaclass=Meta)",
      "+property Session.ttl 32-32 | : int",
      "-property Session._secret 33-33 | ",
      "+method Session.__init__ 35-36 | (self, email: str) -> None",
      "+method Session.expired 38-40 | (self) -> bool",
      "-method Session._rotate 42-43 | (self)",
      "+class Session.Config 45-46 | ",
      "+property Session.Config.frozen 46-46 | ",
      "-class _Internal 49-51 | ",
      "-method _Internal.visible 50-51 | (self)",
    ]);
  });

  it("collects absolute and relative imports, including ones inside functions", async () => {
    expect((await sk("python", SRC)).imports).toEqual(["os", "json", "typing", ".tokens", ".", "..core.db", "hashlib"]);
  });

  it("uses __all__ as the export list when present", async () => {
    const src = `__all__ = ["public_b", "_odd_but_listed"]\n\ndef public_a(): pass\ndef public_b(): pass\ndef _odd_but_listed(): pass\n`;
    expect((await sk("python", src)).symbols).toEqual([
      "-function public_a 3-3 | ()",
      "+function public_b 4-4 | ()",
      "+function _odd_but_listed 5-5 | ()",
    ]);
  });
});
