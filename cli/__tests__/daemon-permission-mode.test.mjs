// cli/__tests__/daemon-permission-mode.test.mjs
// Covers daemon-permission-mode spec: default-yolo, TTY confirm + ack, non-TTY
// warn-only, --chorus-only reverse switch.
import { describe, it, expect } from "vitest";
import {
  resolvePermissionMode,
  hasValidAck,
  isAffirmative,
  yoloWarningLine,
  YOLO_CONFIRM_PROMPT,
} from "../daemon-permission-mode.mjs";

const TTY = { isTTY: true, hasAck: false };
const TTY_ACKED = { isTTY: true, hasAck: true };
const NONTTY = { isTTY: false, hasAck: false };

describe("resolvePermissionMode — default + explicit yolo", () => {
  it("defaults to yolo with no flags/env", () => {
    expect(resolvePermissionMode({}, {}, TTY)).toMatchObject({ mode: "yolo" });
    expect(resolvePermissionMode({}, {}, NONTTY)).toMatchObject({ mode: "yolo" });
  });

  it("--yolo / CHORUS_YOLO=1 also select yolo", () => {
    expect(resolvePermissionMode({ yolo: true }, {}, TTY).mode).toBe("yolo");
    expect(resolvePermissionMode({}, { CHORUS_YOLO: "1" }, TTY).mode).toBe("yolo");
    expect(resolvePermissionMode({}, { CHORUS_YOLO: "true" }, TTY).mode).toBe("yolo");
  });
});

describe("resolvePermissionMode — restricted reverse switch", () => {
  it("--chorus-only forces chorus and never needs confirmation", () => {
    expect(resolvePermissionMode({ chorusOnly: true }, {}, TTY)).toEqual({
      mode: "chorus",
      needConfirm: false,
      warnUnattended: false,
    });
  });

  it("CHORUS_CHORUS_ONLY=1 forces chorus", () => {
    expect(resolvePermissionMode({}, { CHORUS_CHORUS_ONLY: "1" }, NONTTY).mode).toBe("chorus");
  });

  it("CHORUS_YOLO=0 / false is an explicit yolo opt-out → chorus", () => {
    expect(resolvePermissionMode({}, { CHORUS_YOLO: "0" }, TTY).mode).toBe("chorus");
    expect(resolvePermissionMode({}, { CHORUS_YOLO: "false" }, NONTTY).mode).toBe("chorus");
  });

  it("chorus-only beats a simultaneous --yolo (explicit restriction wins)", () => {
    expect(resolvePermissionMode({ yolo: true, chorusOnly: true }, {}, TTY).mode).toBe("chorus");
  });
});

describe("resolvePermissionMode — TTY confirm + ack gate", () => {
  it("TTY yolo with no ack needs confirmation", () => {
    expect(resolvePermissionMode({}, {}, TTY)).toEqual({
      mode: "yolo",
      needConfirm: true,
      warnUnattended: false,
    });
  });

  it("TTY yolo WITH a valid ack does not re-prompt", () => {
    expect(resolvePermissionMode({}, {}, TTY_ACKED)).toEqual({
      mode: "yolo",
      needConfirm: false,
      warnUnattended: false,
    });
  });
});

describe("resolvePermissionMode — non-TTY unattended", () => {
  it("non-TTY yolo starts directly and flags an unattended warning, no confirm", () => {
    expect(resolvePermissionMode({}, {}, NONTTY)).toEqual({
      mode: "yolo",
      needConfirm: false,
      warnUnattended: true,
    });
  });
});

describe("hasValidAck", () => {
  it("treats a non-empty string timestamp as valid", () => {
    expect(hasValidAck("2026-06-21T11:00:00.000Z")).toBe(true);
  });
  it("treats absent/blank/non-string as invalid", () => {
    expect(hasValidAck(undefined)).toBe(false);
    expect(hasValidAck(null)).toBe(false);
    expect(hasValidAck("")).toBe(false);
    expect(hasValidAck("   ")).toBe(false);
    expect(hasValidAck(12345)).toBe(false);
  });
});

describe("isAffirmative", () => {
  it("only y / yes (case- and space-insensitive) confirm", () => {
    for (const yes of ["y", "Y", "yes", "YES", " yes "]) expect(isAffirmative(yes)).toBe(true);
  });
  it("everything else (incl. empty / Enter) declines", () => {
    for (const no of ["", " ", "n", "no", "nope", "sure", "yolo", undefined]) {
      expect(isAffirmative(no)).toBe(false);
    }
  });
});

describe("yoloWarningLine + prompt copy", () => {
  it("warning names --chorus-only as the reclaim switch and flags yolo", () => {
    const w = yoloWarningLine();
    expect(w).toContain("--chorus-only");
    expect(w.toUpperCase()).toContain("YOLO");
  });
  it("confirm prompt asks y/N", () => {
    expect(YOLO_CONFIRM_PROMPT).toMatch(/\[y\/N\]/);
  });
});
