import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Slider } from "./slider";

test("the focusable slider thumb carries the accessible name", () => {
  const html = renderToStaticMarkup(createElement(Slider, { value: [5], min: 2, max: 10, "aria-label": "Investment duration in years" }));
  assert.match(html, /<span[^>]*role="slider"[^>]*aria-label="Investment duration in years"|<span[^>]*aria-label="Investment duration in years"[^>]*role="slider"/);
});
