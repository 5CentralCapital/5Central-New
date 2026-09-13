import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardTrends } from "../../../../../shared/rent-ops-dashboard";
import { DashboardChart } from "./dashboard-chart";
import { dashboardChartSeries, dashboardTrendPoints, defaultDashboardMeasure } from "./dashboard-model";

const fixture = (): DashboardTrends => ({
  asOfDate: "2026-09-12",
  months: ["2026-08", "2026-09"].map((month, index) => ({
    month, asOfDate: index ? "2026-09-12" : "2026-08-31",
    properties: [{ propertyId: "p", propertyName: "Property", unitCount: 10,
      occupiedUnits: index ? 7 : 4, vacantUnits: 3, preleasedUnits: 0, unknownUnits: index ? 0 : 3,
      occupancyRate: index ? 70 : null, vacancyRate: index ? 30 : null,
      baseRentCents: index ? 700000 : null, confirmedBaseRentCents: index ? 700000 : 0,
      unconfirmedRentUnits: index ? 0 : 4 }],
  })),
});

test("partial historical units are confirmed counts with coverage, never a complete percent", () => {
  const data = fixture();
  assert.equal(defaultDashboardMeasure(data), "units");
  assert.deepEqual(dashboardChartSeries(data, "portfolio", "occupancy", "units")[0].values, [4, 7]);
  assert.deepEqual(dashboardChartSeries(data, "portfolio", "vacancy", "units")[0].values, [3, 3]);
  assert.deepEqual(dashboardChartSeries(data, "portfolio", "occupancy", "units")[0].unknownUnits, [3, 0]);
  assert.deepEqual(dashboardChartSeries(data, "portfolio", "occupancy", "rate")[0].values, [null, 70]);
  assert.deepEqual(dashboardChartSeries(data, "portfolio", "rent", "units")[0].values, [null, 7000]);
  data.months[0].properties[0].unknownUnits = 0;
  assert.equal(defaultDashboardMeasure(data), "rate");
});

test("comparison and property series preserve independent unknown coverage", () => {
  const data = fixture();
  for (const month of data.months) month.properties.push({ ...month.properties[0], propertyId: "q", propertyName: "Second", unknownUnits: 0, occupiedUnits: 7, occupancyRate: 70 });
  const series = dashboardChartSeries(data, "compare", "occupancy", "rate");
  assert.deepEqual(series[0].values, [null, 70]);
  assert.deepEqual(series[1].values, [70, 70]);
  assert.deepEqual(dashboardChartSeries(data, "q", "occupancy", "units")[0].unknownUnits, [0, 0]);
});

test("initial rendered chart visibly labels confirmed counts and accessible month coverage", () => {
  const html = renderToStaticMarkup(<DashboardChart metric="occupancy" data={fixture()} loading={false} onRetry={() => {}} />);
  assert.match(html, /Confirmed occupied units/);
  assert.match(html, /value="units" selected=""/);
  assert.match(html, /2026-08-31: Portfolio 4, 3 units unknown/);
  assert.match(html, /Some months have unknown units/);
  assert.match(html, />Percent<\/option>/);
  const vacancy = renderToStaticMarkup(<DashboardChart metric="vacancy" data={fixture()} loading={false} onRetry={() => {}} />);
  assert.match(vacancy, /Confirmed vacant units/);
});

test("rent chart leaves historical values absent with a concise explanation", () => {
  const html = renderToStaticMarkup(<DashboardChart metric="rent" data={fixture()} loading={false} onRetry={() => {}} />);
  assert.match(html, /Historical charge dates or frequency missing/);
  assert.match(html, /2026-08-31: Portfolio —/);
  assert.doesNotMatch(html, /Confirmed vacant units/);
});

test("recorded mode preserves exact dates, labels the source, and keeps current point", () => {
  const data = fixture();
  data.archivedSnapshots = [{
    asOfDate: "2026-08-03",
    sourceSystem: "appfolio",
    properties: [{ ...data.months[0].properties[0] }],
  }];
  const points = dashboardTrendPoints(data, "recorded");
  assert.deepEqual(points.map(point => point.asOfDate), ["2026-08-03", "2026-09-12"]);
  assert.deepEqual(dashboardChartSeries(data, "portfolio", "occupancy", "units", "recorded")[0].values, [4, 7]);
  const html = renderToStaticMarkup(<DashboardChart metric="occupancy" data={data} loading={false} onRetry={() => {}} />);
  assert.match(html, /Recorded dates/);
  assert.match(html, /2026-08-03 · Evernest/);
  assert.match(html, /2 recorded dates/);
});
