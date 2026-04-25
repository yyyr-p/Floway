import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { DashboardPage } from "./dashboard.tsx";

function extractDashboardScript() {
  const html = DashboardPage().toString();
  const scripts = html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g);
  for (const script of scripts) {
    if (script[1].includes("function dashboardApp()")) return script[1];
  }
  throw new Error("dashboard script not found");
}

function createDashboardHarness() {
  const charts: any[] = [];
  class FakeChart {
    canvas: unknown;
    data: any;
    options: any;
    visibility = new Map<number, boolean>();
    lastUpdateMode: string | null = null;

    constructor(canvas: unknown, config: any) {
      this.canvas = canvas;
      this.data = config.data;
      this.options = config.options;
      charts.push(this);
    }

    stop() {}
    destroy() {}

    setDatasetVisibility(index: number, visible: boolean) {
      this.visibility.set(index, visible);
    }

    update(mode: string) {
      this.lastUpdateMode = mode;
    }
  }

  const localStorage = {
    getItem(key: string) {
      if (key === "authKey") return "test-key";
      if (key === "isAdmin") return "1";
      return null;
    },
    removeItem() {},
  };
  const location = { hash: "#usage", origin: "https://example.test" };
  const window = { addEventListener() {}, location };
  const document = {
    getElementById(id: string) {
      return { id, clientWidth: 640 };
    },
  };

  const dashboardApp = new Function(
    "localStorage",
    "location",
    "window",
    "document",
    "Chart",
    extractDashboardScript() + "\nreturn dashboardApp;",
  )(localStorage, location, window, document, FakeChart);

  return { app: dashboardApp(), charts };
}

function usageRecord(offsetHours: number, overrides: Record<string, unknown>) {
  const date = new Date();
  date.setHours(date.getHours() + offsetHours, 0, 0, 0);
  return {
    hour: date.toISOString().slice(0, 13),
    keyId: "key_1",
    keyName: "Primary",
    model: "model-a",
    requests: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

const TEST_USAGE_KEY_COLOR_ORDER = [
  "46360b74-2457-4a38-a116-7afdb2894632",
  "4969165b-3412-436c-87d9-3fd4770164b5",
  "541128df-ee71-4fc1-9cc7-6855ca1e7fcc",
  "e694733c-370e-4b9a-9331-57eefd12a8cc",
  "5a4481c9-0230-481c-bd17-49fc2bda6f02",
  "future-1",
  "3f2fe5b9-2991-4bb8-bc04-2852f58150ca",
  "future-3",
  "future-2",
  "future-4",
];

Deno.test("DashboardPage renders split dashboard shell", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, 'x-data="dashboardApp()"');
  assertStringIncludes(html, "Copilot Gateway");
  assertStringIncludes(html, "API Keys");
  assertStringIncludes(html, "Total Tokens");
  assertStringIncludes(html, "Cache Hit Rate");
  assertStringIncludes(html, "function dashboardApp()");
});

Deno.test("DashboardPage renders the search section below the usage cards without architecture labels", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "Search Provider");
  assertStringIncludes(html, "Tavily");
  assertStringIncludes(html, "Microsoft Grounding");
  assertStringIncludes(html, "Save Search Config");
  assertStringIncludes(html, "Test Search");
  assertStringIncludes(
    html,
    ":disabled=\"!searchConfigLoaded || searchConfigTesting || searchConfigDraft.provider === 'disabled'\"",
  );
  assertFalse(html.includes("Control Plane"));
  assertFalse(html.includes("Data Plane"));
  assertFalse(
    html.indexOf("Search Provider") < html.indexOf("Premium Requests"),
  );
});

Deno.test("DashboardPage renders helper functions inside script without HTML entity encoding", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "const draftFromSearchConfig = ");
  assertStringIncludes(html, "const activeCredentialValue = ");
  assertStringIncludes(html, "const setActiveCredentialValue = ");
  assertStringIncludes(html, "const searchConfigFromDraft = ");
  assertFalse(html.includes("=&gt;"));
  assertFalse(html.includes("&quot;tavily&quot;"));
});

Deno.test("DashboardPage renders clickable usage summary metrics for chart axis selection", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "tokenChartMetric: 'total'");
  assertStringIncludes(html, "@click=\"switchTokenChartMetric('requests')\"");
  assertStringIncludes(html, "@click=\"switchTokenChartMetric('total')\"");
  assertStringIncludes(html, "@click=\"switchTokenChartMetric('input')\"");
  assertStringIncludes(html, "@click=\"switchTokenChartMetric('output')\"");
  assertStringIncludes(
    html,
    "@click=\"switchTokenChartMetric('cacheCreation')\"",
  );
  assertStringIncludes(
    html,
    "@click=\"switchTokenChartMetric('cacheHitRate')\"",
  );
  assertStringIncludes(html, ":class=\"tokenChartMetric === 'total'");
});

Deno.test("DashboardPage does not embed production usage key ids in public HTML", () => {
  const html = DashboardPage().toString();

  assertFalse(html.includes("46360b74-2457-4a38-a116-7afdb2894632"));
  assertFalse(html.includes("4969165b-3412-436c-87d9-3fd4770164b5"));
  assertFalse(html.includes("3f2fe5b9-2991-4bb8-bc04-2852f58150ca"));
});

Deno.test("DashboardPage preserves empty cache hit rate chart points", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(
    html,
    "return total > 0 ? (detail.cacheRead / total) * 100 : null;",
  );
  assertStringIncludes(
    html,
    "return this.tokenChartMetric === 'cacheHitRate' ? null : 0;",
  );
  assertStringIncludes(
    html,
    "item.parsed.y !== null && (self.tokenChartMetric === 'cacheHitRate' || item.parsed.y > 0)",
  );
});

Deno.test("DashboardPage connects cache hit rate lines across empty points", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(
    html,
    "ds.spanGaps = metric === 'cacheHitRate';",
  );
  assertStringIncludes(
    html,
    "spanGaps: self.tokenChartMetric === 'cacheHitRate'",
  );
});

Deno.test("dashboardApp updates chart data and options when switching summary metrics", () => {
  const { app, charts } = createDashboardHarness();
  app.tokenData = [
    usageRecord(-2, {
      requests: 2,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 5,
      cacheCreationTokens: 5,
    }),
    usageRecord(-1, {
      requests: 3,
      inputTokens: 20,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }),
    usageRecord(0, {
      requests: 4,
      inputTokens: 6,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheCreationTokens: 1,
    }),
  ];

  app.renderTokenCharts();
  assertEquals(charts.length, 2);
  for (const chart of charts) {
    assertEquals(chart.options.scales.y.title.text, "Total Tokens");
    assertEquals(chart.options.scales.y.stacked, true);
    assertEquals(chart.data.datasets[0].fill, "stack");
    assertEquals(chart.data.datasets[0].spanGaps, false);
    assertFalse(chart.data.datasets[0].data.includes(null));
    assert(chart.data.datasets[0].data.includes(15));
    assert(chart.data.datasets[0].data.includes(27));
    assert(chart.data.datasets[0].data.includes(10));
  }

  app.switchTokenChartMetric("cacheHitRate");
  assertEquals(app.tokenChartMetric, "cacheHitRate");
  for (const chart of charts) {
    assertEquals(chart.options.scales.y.title.text, "Cache Hit Rate");
    assertEquals(chart.options.scales.y.stacked, false);
    assertEquals(chart.options.scales.y.suggestedMax, 100);
    assertEquals(chart.data.datasets[0].fill, false);
    assertEquals(chart.data.datasets[0].spanGaps, true);
    assert(chart.data.datasets[0].data.includes(50));
    assert(chart.data.datasets[0].data.includes(75));
    assert(chart.data.datasets[0].data.includes(null));
  }

  app.switchTokenChartMetric("requests");
  assertEquals(app.tokenChartMetric, "requests");
  for (const chart of charts) {
    assertEquals(chart.options.scales.y.title.text, "Requests");
    assertEquals(chart.options.scales.y.stacked, true);
    assertEquals(chart.options.scales.y.suggestedMax, undefined);
    assertEquals(chart.data.datasets[0].fill, "stack");
    assertEquals(chart.data.datasets[0].spanGaps, false);
    assertFalse(chart.data.datasets[0].data.includes(null));
    assert(chart.data.datasets[0].data.includes(2));
    assert(chart.data.datasets[0].data.includes(3));
    assert(chart.data.datasets[0].data.includes(4));
  }
});

Deno.test("dashboardApp keeps known usage key colors on selected slots when earlier keys are absent", () => {
  const { app, charts } = createDashboardHarness();
  app.tokenKeyColorOrder = TEST_USAGE_KEY_COLOR_ORDER;
  app.tokenData = [
    usageRecord(-1, {
      keyId: "4969165b-3412-436c-87d9-3fd4770164b5",
      keyName: "Menci",
      keyCreatedAt: "2026-03-09T09:48:00.125Z",
    }),
    usageRecord(0, {
      keyId: "3f2fe5b9-2991-4bb8-bc04-2852f58150ca",
      keyName: "ceerRep",
      keyCreatedAt: "2026-04-22T14:20:03.256Z",
    }),
  ];

  app.renderTokenCharts();

  const keyChart = charts[0];
  const menci = keyChart.data.datasets.find((ds: any) =>
    ds._keyId === "4969165b-3412-436c-87d9-3fd4770164b5"
  );
  const ceerRep = keyChart.data.datasets.find((ds: any) =>
    ds._keyId === "3f2fe5b9-2991-4bb8-bc04-2852f58150ca"
  );
  assertEquals(menci.borderColor, "#00e676");
  assertEquals(menci.backgroundColor, "#00e67640");
  assertEquals(ceerRep.borderColor, "#64ffda");
  assertEquals(ceerRep.backgroundColor, "#64ffda40");
});

Deno.test("dashboardApp assigns new usage keys to reordered future color slots by creation order", () => {
  const { app, charts } = createDashboardHarness();
  app.tokenKeyColorOrder = TEST_USAGE_KEY_COLOR_ORDER;
  app.tokenData = [
    usageRecord(-3, {
      keyId: "new-key-1",
      keyName: "Future A",
      keyCreatedAt: "2026-05-01T00:00:00.000Z",
    }),
    usageRecord(-2, {
      keyId: "new-key-2",
      keyName: "Future B",
      keyCreatedAt: "2026-05-02T00:00:00.000Z",
    }),
    usageRecord(-1, {
      keyId: "new-key-3",
      keyName: "Future C",
      keyCreatedAt: "2026-05-03T00:00:00.000Z",
    }),
  ];

  app.renderTokenCharts();

  const keyChart = charts[0];
  const colorsByKey = new Map(
    keyChart.data.datasets.map((ds: any) => [ds._keyId, ds.borderColor]),
  );
  assertEquals(colorsByKey.get("new-key-1"), "#ff6e40");
  assertEquals(colorsByKey.get("new-key-2"), "#40c4ff");
  assertEquals(colorsByKey.get("new-key-3"), "#eeff41");
});

Deno.test("dashboardApp keeps future key colors stable when an earlier future key is absent", () => {
  const { app, charts } = createDashboardHarness();
  app.tokenKeyColorOrder = TEST_USAGE_KEY_COLOR_ORDER;
  app.tokenKeyMetadata = [
    {
      id: "new-key-1",
      name: "Future A",
      createdAt: "2026-05-01T00:00:00.000Z",
    },
    {
      id: "new-key-2",
      name: "Future B",
      createdAt: "2026-05-02T00:00:00.000Z",
    },
  ];
  app.tokenData = [
    usageRecord(-1, {
      keyId: "new-key-2",
      keyName: "Future B",
      keyCreatedAt: "2026-05-02T00:00:00.000Z",
    }),
  ];

  app.renderTokenCharts();

  const keyChart = charts[0];
  assertEquals(keyChart.data.datasets[0]._keyId, "new-key-2");
  assertEquals(keyChart.data.datasets[0].borderColor, "#40c4ff");
  assertEquals(keyChart.data.datasets[0].backgroundColor, "#40c4ff40");
});

Deno.test("dashboardApp uses key id to break future key creation-time ties", () => {
  const { app, charts } = createDashboardHarness();
  app.tokenKeyColorOrder = TEST_USAGE_KEY_COLOR_ORDER;
  app.tokenKeyMetadata = [
    {
      id: "new-key-b",
      name: "Alpha renamed",
      createdAt: "2026-05-01T00:00:00.000Z",
    },
    {
      id: "new-key-a",
      name: "Zulu renamed",
      createdAt: "2026-05-01T00:00:00.000Z",
    },
  ];
  app.tokenData = [
    usageRecord(-1, {
      keyId: "new-key-b",
      keyName: "Alpha renamed",
      keyCreatedAt: "2026-05-01T00:00:00.000Z",
    }),
  ];

  app.renderTokenCharts();

  const keyChart = charts[0];
  assertEquals(keyChart.data.datasets[0]._keyId, "new-key-b");
  assertEquals(keyChart.data.datasets[0].borderColor, "#40c4ff");
  assertEquals(keyChart.data.datasets[0].backgroundColor, "#40c4ff40");
});

Deno.test("dashboardApp keeps model colors on known model-id slots when earlier models are absent", () => {
  const { app, charts } = createDashboardHarness();
  app.allModels = [{ id: "model-a" }, { id: "model-b" }];
  app.tokenData = [
    usageRecord(0, {
      model: "model-b",
    }),
  ];

  app.renderTokenCharts();

  const modelChart = charts[1];
  assertEquals(modelChart.data.datasets[0]._model, "model-b");
  assertEquals(modelChart.data.datasets[0].borderColor, "#00e676");
  assertEquals(modelChart.data.datasets[0].backgroundColor, "#00e67640");
});

Deno.test("dashboardApp aligns dotted Claude usage IDs with dashed model metadata slots", () => {
  const { app, charts } = createDashboardHarness();
  app.allModels = [{ id: "claude-opus-4-7" }, { id: "claude-sonnet-4-7" }];
  app.tokenData = [
    usageRecord(0, {
      model: "claude-sonnet-4.7",
    }),
  ];

  app.renderTokenCharts();

  const modelChart = charts[1];
  assertEquals(modelChart.data.datasets[0]._model, "claude-sonnet-4-7");
  assertEquals(modelChart.data.datasets[0].borderColor, "#00e676");
  assertEquals(modelChart.data.datasets[0].backgroundColor, "#00e67640");
});

Deno.test("dashboardApp reapplies known model-id color slots when model metadata finishes loading", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "model-a",
              name: "Model A",
              model_picker_enabled: true,
              capabilities: {},
              supported_endpoints: [],
            },
            {
              id: "model-b",
              name: "Model B",
              model_picker_enabled: true,
              capabilities: {},
              supported_endpoints: [],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

  try {
    const { app, charts } = createDashboardHarness();
    app.$nextTick = () => Promise.resolve();
    app.tokenData = [usageRecord(0, { model: "model-b" })];
    app.renderTokenCharts();
    assertEquals(charts[1].data.datasets[0].borderColor, "#00e5ff");

    await app.loadModels();

    const modelChart = charts.at(-1);
    assertEquals(modelChart.data.datasets[0]._model, "model-b");
    assertEquals(modelChart.data.datasets[0].borderColor, "#00e676");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("DashboardPage usage summary metric focus styling only shows borders on hover or focus-visible", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(
    html,
    "border border-transparent cursor-pointer transition-colors hover:border-white/10 focus:outline-none focus-visible:border-accent-cyan/40",
  );
  assertFalse(html.includes("focus:ring"));
});
