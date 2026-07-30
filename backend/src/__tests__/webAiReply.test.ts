// The `ai_web_*` sub-steps ask the vision model for a marker number and get back whatever
// the model felt like sending: the JSON that was asked for, the same JSON in a fence, a
// sentence with the number in it. Anything a number can be read out of is a usable answer,
// so the parser has to be forgiving -- but not so forgiving that it invents a marker and
// clicks something nobody asked for.
vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { describe, it, expect, vi } from "vitest";
import { parseWebAiReply } from "../jobs/cloudflare";

describe("parseWebAiReply", () => {
  it("reads the JSON object it asked for", () => {
    expect(parseWebAiReply('{"mark": 3}')).toEqual({ mark: 3, text: undefined });
  });

  it("reads a mark and the text to type", () => {
    expect(parseWebAiReply('{"mark": 2, "text": "A7X9"}')).toEqual({ mark: 2, text: "A7X9" });
  });

  it("finds the object inside a code fence", () => {
    expect(parseWebAiReply('```json\n{"mark": 5}\n```')).toEqual({ mark: 5, text: undefined });
  });

  it("finds the object inside surrounding prose", () => {
    const reply = 'Looking at the page, the login button is marker 4.\n{"mark": 4}\nHope that helps!';
    expect(parseWebAiReply(reply).mark).toBe(4);
  });

  it("falls back to a key/value pair when the JSON will not parse", () => {
    expect(parseWebAiReply('{mark: 7, note: unquoted}').mark).toBe(7);
  });

  it("accepts a bare number, which is what small models tend to send", () => {
    expect(parseWebAiReply("6").mark).toBe(6);
    expect(parseWebAiReply("Marker 11").mark).toBe(11);
  });

  it("reports no mark when the model declines, so the step fails instead of guessing", () => {
    expect(parseWebAiReply('{"mark": 0}').mark).toBeUndefined();
    expect(parseWebAiReply("none of them are right").mark).toBeUndefined();
    expect(parseWebAiReply("").mark).toBeUndefined();
  });

  it("ignores a non-integer mark rather than rounding it into a different element", () => {
    expect(parseWebAiReply('{"mark": 2.5}').mark).toBeUndefined();
    expect(parseWebAiReply('{"mark": "the blue one"}').mark).toBeUndefined();
  });

  it("keeps the text only when it is a string", () => {
    expect(parseWebAiReply('{"mark": 1, "text": 42}').text).toBeUndefined();
    expect(parseWebAiReply('{"mark": 1, "text": ""}').text).toBe("");
  });
});
