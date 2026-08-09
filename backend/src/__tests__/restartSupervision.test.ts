// The panel's restart button reads differently depending on the answer here: a process
// nothing will start again should say so before it goes, not look like it hung.
import { describe, it, expect, afterEach } from "vitest";
import { restartSupervised } from "../system/restart";

const saved = {
  supervised: process.env.BEMBY_SUPERVISED,
  railway: process.env.RAILWAY_ENVIRONMENT,
};

afterEach(() => {
  for (const [key, value] of [
    ["BEMBY_SUPERVISED", saved.supervised],
    ["RAILWAY_ENVIRONMENT", saved.railway],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("whether a restart brings the backend back", () => {
  it("takes the operator's word over anything it can detect", () => {
    process.env.BEMBY_SUPERVISED = "1";
    expect(restartSupervised()).toBe(true);
    process.env.BEMBY_SUPERVISED = "0";
    expect(restartSupervised()).toBe(false);
  });

  it("counts a Railway deployment as supervised", () => {
    delete process.env.BEMBY_SUPERVISED;
    process.env.RAILWAY_ENVIRONMENT = "production";
    expect(restartSupervised()).toBe(true);
  });
});
