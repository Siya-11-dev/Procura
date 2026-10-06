import { describe, expect, it } from "vitest";
import {
  parseBudget,
  parseNeededBy,
  parseQuantity,
} from "@/lib/agents/parsing";

describe("parseNeededBy", () => {
  it("reads a named date that is shadowed by an earlier number-word pair", () => {
    // Regression: String.match returned only "15 USB", so MONTHS["usb"] was
    // undefined and the real "15 November" was never examined.
    const text =
      "We need 15 USB-C docking stations for the design studio. " +
      "Budget is R180000, needed by 15 November 2026.";
    expect(parseNeededBy(text)).toBe("2026-11-15");
  });

  it("reads a plain named date", () => {
    expect(parseNeededBy("Deliver by 3 March 2027 please")).toBe("2027-03-03");
  });

  it("prefers an ISO date over a named one", () => {
    expect(parseNeededBy("ship by 2026-09-30, not 1 January")).toBe("2026-09-30");
  });

  it("resolves a relative deadline", () => {
    expect(parseNeededBy("we need them within 6 weeks")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns null when no date is present", () => {
    expect(parseNeededBy("We need some chairs.")).toBeNull();
  });

  it("ignores an out of range day", () => {
    // 15 USB is not a month, and 45 November is not a date.
    expect(parseNeededBy("quantity 45 November of nothing")).toBeNull();
  });
});

describe("parseQuantity", () => {
  it("reads a count against a unit noun", () => {
    expect(parseQuantity("We need 24 task chairs")).toBe(24);
    expect(parseQuantity("40 ergonomic sit-stand desks")).toBe(40);
  });

  it("reads a count against newly added IT nouns", () => {
    // Regression: "docking station" was absent from the unit vocabulary, so the
    // order silently collapsed to a single unit.
    expect(parseQuantity("We need 15 USB-C docking stations")).toBe(15);
    expect(parseQuantity("20 headsets and 8 webcams")).toBe(20);
  });

  it("reads written numbers", () => {
    expect(parseQuantity("a dozen chairs")).toBe(12);
  });

  it("does not read durations as quantities", () => {
    expect(parseQuantity("deliver in 3 days")).toBeNull();
  });

  it("does not read a specification as a quantity", () => {
    expect(parseQuantity("4K monitors with 32GB RAM")).toBeNull();
  });

  it("does not read a year as a quantity", () => {
    expect(parseQuantity("chairs needed for the 2026 floor")).toBeNull();
  });
});

describe("parseBudget", () => {
  it("reads a rand amount", () => {
    expect(parseBudget("Budget is R300,000")).toBe(300_000);
  });

  it("reads a thousands suffix", () => {
    expect(parseBudget("roughly R250k")).toBe(250_000);
  });

  it("does not treat a wattage as money", () => {
    // Regression risk from the lookbehind: "r" inside a word must not act as
    // the rand sign.
    expect(parseBudget("Four 600W monolights")).toBeNull();
  });
});
