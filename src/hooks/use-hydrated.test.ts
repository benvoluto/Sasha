import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useHydrated } from "./use-hydrated";

function Probe() {
  return createElement("span", null, useHydrated() ? "client" : "server");
}

describe("useHydrated", () => {
  it("is false in the server render, so the HTML never holds client-only markup", () => {
    expect(renderToString(createElement(Probe))).toBe("<span>server</span>");
  });
});
