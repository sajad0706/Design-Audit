import type { LayerToken, ProductionReference, SelectedFigmaComponent } from "../src/shared/types";
import { normalizeColor, valuesMatch } from "../src/shared/tokenUtils";
import { createProductionTokenIndex, mapFigmaTokenToProduction } from "../src/plugin/tokenMapper";
import { componentDisplayScore, hasHardMatchWarning, rankReferenceForSelection } from "../src/ui/componentMatcher";
import { parseProductionSource } from "../src/ui/sourceParser";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function file(name: string, text: string) {
  return { name, size: text.length, text };
}

export async function runQaSmoke(): Promise<void> {
  testHtmlCssDetection();
  testUnsafeMarkupSanitizing();
  testCssOnlyFallback();
  testReactComponentDetection();
  testPersianFinancialWidgetDetection();
  testUtilityWrapperDoesNotWinDetection();
  testUtilityPreviewCssArbitraryValues();
  testSelectionMatcherDemotesGenericWrappers();
  testRepoComponentRanking();
  testJsThemeColorTokens();
  testTokenNormalization();
  testTokenMapping();
  console.log("QA smoke tests passed.");
}

function testHtmlCssDetection(): void {
  const html = `
    <button class="primary-button">
      <span class="label">Save order</span>
    </button>
  `;
  const css = `
    :root {
      --color-primary-blue: #1a73e8;
      --radius-md: 8px;
      --space-sm: 8px;
      --space-md: 12px;
      --font-button-size: 0.875rem;
    }
    .primary-button {
      background: var(--color-primary-blue);
      color: rgb(255, 255, 255);
      border-radius: var(--radius-md);
      padding: var(--space-sm) var(--space-md);
      font-size: var(--font-button-size);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
    }
    .unused-card { padding: 40px; color: #ff00ff; }
  `;
  const reference = parseProductionSource([file("button.html", html), file("button.css", css)], "html-css", "Pasted HTML + CSS");
  const candidate = reference.components[0];

  assert(candidate, "Expected an HTML + CSS component candidate.");
  assert(candidate.html.includes("primary-button"), "Expected candidate preview HTML to preserve the component class.");
  assert(candidate.css.includes(".primary-button"), "Expected preview CSS to include related class rules.");
  assert(!candidate.css.includes(".unused-card"), "Expected preview CSS to omit unrelated rules.");
  assert(candidate.confidence >= 70, "Expected HTML + CSS confidence to be high.");
  assert(reference.tokens.some((token) => token.category === "spacing" && token.value === 12), "Expected padding shorthand to expose the 12px spacing value.");
  assert(reference.tokens.some((token) => token.category === "typography" && token.value === 14), "Expected rem typography token to normalize to px.");
}

function testUnsafeMarkupSanitizing(): void {
  const html = `<div class="card" onclick="alert(1)"><script>alert(1)</script><img src="https://example.com/x.png" onerror="alert(2)">Safe</div>`;
  const reference = parseProductionSource([file("unsafe.html", html), file("unsafe.css", ".card { color: #111; }")], "production-file", "unsafe.html");
  const candidate = reference.components[0];

  assert(candidate, "Expected sanitized unsafe HTML to still produce a component.");
  assert(!/script/i.test(candidate.html), "Expected script tags to be removed from preview HTML.");
  assert(!/onerror|onclick/i.test(candidate.html), "Expected event handlers to be removed from preview HTML.");
}

function testCssOnlyFallback(): void {
  const reference = parseProductionSource([file("button.css", ".ghost-button { color: #111111; border-radius: 6px; }")], "production-file", "button.css");
  const candidate = reference.components[0];

  assert(candidate, "Expected CSS-only input to produce a fallback candidate.");
  assert(candidate.confidence < 60, "Expected CSS-only fallback confidence to stay low.");
  assert(candidate.html.includes("ghost-button"), "Expected CSS-only fallback HTML to use the detected selector.");
}

function testReactComponentDetection(): void {
  const source = `
    export function TradeButton() {
      return (
        <button className="trade-button">
          <span className="label">Trade</span>
        </button>
      );
    }
  `;
  const css = ".trade-button { background: #0d99ff; border-radius: 8px; }";
  const reference = parseProductionSource([file("TradeButton.tsx", source), file("TradeButton.css", css)], "repo-upload", "repo");
  const candidate = reference.components[0];

  assert(candidate, "Expected React component to produce a candidate.");
  assert(candidate.name === "Trade Button", "Expected React component name to be humanized.");
  assert(candidate.html.includes("class="), "Expected React className to be converted for preview.");
}

function testPersianFinancialWidgetDetection(): void {
  const html = `
    <div id="app" class="app-shell flex">
      <aside class="toolbar">
        <button class="icon-button">⌕</button>
        <button class="icon-button">⚙</button>
      </aside>
      <main class="page-content">
        <section class="market-widget financial-table" dir="rtl" data-component="MarketWidget">
          <header class="market-header">
            <h2>دیده‌بان بازار</h2>
            <nav class="market-tabs">
              <button class="tab active">بورس</button>
              <button class="tab">فرابورس</button>
            </nav>
          </header>
          <div class="market-table" role="table">
            <div class="market-row positive" role="row">
              <span class="symbol">خودرو</span>
              <span class="price">۲,۴۵۰</span>
              <span class="change">+۱.۸٪</span>
            </div>
            <div class="market-row negative" role="row">
              <span class="symbol">فولاد</span>
              <span class="price">۱,۲۳۰</span>
              <span class="change">-۰.۶٪</span>
            </div>
            <div class="market-row positive" role="row">
              <span class="symbol">شستا</span>
              <span class="price">۸۷۰</span>
              <span class="change">+۰.۳٪</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  `;
  const css = `
    :root {
      --backgroundColor-brand-primary: rgb(24, 161, 90);
      --surface-primary: #ffffff;
      --surface-secondary: #f6f7f9;
      --danger: #d93025;
      --radius-md: 8px;
    }
    .app-shell { display: flex; gap: 16px; }
    .toolbar { width: 44px; display: flex; flex-direction: column; }
    .market-widget {
      width: 469px;
      min-height: 315px;
      direction: rtl;
      background: var(--surface-primary);
      border: 1px solid #e2e6ea;
      border-radius: var(--radius-md);
      padding: 12px;
      font-family: Vazirmatn, Tahoma, sans-serif;
    }
    .market-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .market-tabs { display: flex; gap: 8px; }
    .tab.active { background: var(--backgroundColor-brand-primary); color: #fff; }
    .market-row { display: grid; grid-template-columns: 1fr 80px 64px; gap: 8px; padding: 10px 8px; border-top: 1px solid #edf0f2; }
    .positive .change { color: var(--backgroundColor-brand-primary); }
    .negative .change { color: var(--danger); }
    .w-\\[469px\\] { width: 469px; }
  `;
  const reference = parseProductionSource([file("market.html", html), file("market.css", css)], "html-css", "Pasted HTML + CSS");
  const candidate = reference.components[0];

  assert(candidate, "Expected Persian financial HTML + CSS to produce candidates.");
  assert(candidate.html.includes("market-widget"), "Expected the market widget, not the app shell or icon controls, to be ranked first.");
  assert(candidate.html.includes("دیده‌بان بازار"), "Expected Persian/RTL text to remain in the detected preview.");
  assert(candidate.css.includes(".market-widget"), "Expected preview CSS to include the component rule.");
  assert(candidate.css.includes("--backgroundColor-brand-primary"), "Expected preview CSS to keep inherited CSS variables.");
  assert(candidate.confidence >= 80, "Expected meaningful Persian financial component confidence to be high.");
}

function testUtilityWrapperDoesNotWinDetection(): void {
  const html = `
    <div class="flex flex-row h-[calc(100vh-80px)]">
      <div class="basis-[22rem] text-center my-1 mr-2">
        <div class="splitpanes splitpanes--horizontal default-theme">
          <div class="splitpanes__pane">
            <div class="flex flex-col rounded-md bg-neutral-secondary h-full pb-1">
              <div role="tablist" class="w-full mt-1 inline-flex overflow-auto">
                <button role="tab" class="font-bold border-b border-brand-primary text-brand-primary">دیده‌بان</button>
                <button role="tab" class="font-bold border-b border-neutral-secondary">صنایع</button>
              </div>
              <div id="tabpanel-2" role="tabpanel" class="h-full flex flex-col">
                <div class="rounded-md h-full overflow-auto border border-neutral-tertiary m-2">
                  <table class="border-collapse border-spacing-0 w-full rtl:text-right text-left bg-neutral-primary">
                    <thead><tr><th>نام نماد</th><th>قیمت</th><th>%پایانی</th></tr></thead>
                    <tbody>
                      <tr><td>سامان</td><td>3,258</td><td>2.34%</td></tr>
                      <tr><td>خودرو</td><td>1,468</td><td>0.21%</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  const css = `
    --backgroundColor-neutral-primary: 255 255 255;
    --backgroundColor-neutral-secondary: 243 243 243;
    --borderColor-brand-primary: 22 123 71;
    --textColor-brand-primary: 22 123 71;
    .flex { display: flex; }
    .rounded-md { border-radius: 8px; }
  `;
  const reference = parseProductionSource([file("watchlist.html", html), file("watchlist.css", css)], "html-css", "Pasted HTML + CSS");
  const candidate = reference.components[0];

  assert(candidate, "Expected utility-heavy watchlist HTML to produce candidates.");
  assert(!/^<div class="flex flex-row/.test(candidate.html), "Expected generic flex wrapper not to be ranked first.");
  assert(candidate.html.includes("tabpanel") || candidate.html.includes("<table"), "Expected a meaningful tab panel or table candidate.");
  assert(candidate.css.includes(".flex"), "Expected utility fallback CSS to help the preview render flex layout.");
  assert(candidate.css.includes("backgroundColor-neutral-primary"), "Expected loose CSS variables to be wrapped for preview.");
}

function testUtilityPreviewCssArbitraryValues(): void {
  const html = `<section class="flex basis-[22rem] h-[calc(100vh-80px)] rtl:text-right bg-[#ffffff]" dir="rtl">نمایش بازار</section>`;
  const reference = parseProductionSource([file("utility.html", html), file("utility.css", "")], "html-css", "Pasted HTML + CSS");
  const candidate = reference.components[0];

  assert(candidate, "Expected utility-only HTML to produce a candidate.");
  assert(candidate.css.includes("flex-basis: 22rem;"), "Expected arbitrary Tailwind basis sizing to render in the preview.");
  assert(candidate.css.includes("height: calc(100vh-80px);"), "Expected arbitrary Tailwind height sizing to render in the preview.");
  assert(candidate.css.includes(".rtl\\:text-right"), "Expected RTL utility classes to be preserved for preview.");
  assert(candidate.css.includes("background: #ffffff;"), "Expected arbitrary utility colors to render in the preview.");
}

function testSelectionMatcherDemotesGenericWrappers(): void {
  const selected: SelectedFigmaComponent = {
    nodeId: "figma-node",
    name: "دیده‌بان بازار",
    type: "Frame",
    width: 469,
    height: 315,
    childCount: 22,
    textSample: "دیده‌بان بازار نام نماد قیمت سامان خودرو درصد پایانی",
    hasRtlText: true,
    hasSelection: true,
    styleSummary: "fills, strokes, 22 layers"
  };
  const reference: ProductionReference = {
    label: "Pasted HTML + CSS",
    inputKind: "html-css",
    tokens: [],
    sourceSummary: { fileCount: 2, totalBytes: 1, colors: 0, typography: 0, spacing: 0, radius: 0, effects: 0 },
    components: [
      {
        id: "wrapper",
        name: "Flex",
        sourceLabel: "Pasted HTML + CSS",
        sourceFile: "input.html",
        inputKind: "html-css",
        confidence: 96,
        html: `<div class="basis-[22rem] text-center my-1 mr-2"><div><section role="tabpanel" dir="rtl"><table><tbody><tr><td>سامان</td><td>3,258</td></tr><tr><td>خودرو</td><td>1,468</td></tr></tbody></table></section></div></div>`,
        css: ".flex { display: flex; }",
        summary: "generic wrapper",
        reason: "Found a main HTML block.",
        tokenIds: []
      },
      {
        id: "market-table",
        name: "Market Table",
        sourceLabel: "Pasted HTML + CSS",
        sourceFile: "input.html",
        inputKind: "html-css",
        confidence: 82,
        html: `<section role="tabpanel" dir="rtl" class="rounded-md market-table"><header>دیده‌بان بازار</header><table><tbody><tr><td>سامان</td><td>3,258</td></tr><tr><td>خودرو</td><td>1,468</td></tr></tbody></table></section>`,
        css: ".market-table { width: 469px; height: 315px; direction: rtl; }",
        summary: "market table component",
        reason: "Found a meaningful component.",
        tokenIds: []
      }
    ]
  };
  const ranked = rankReferenceForSelection(reference, selected);
  const wrapper = ranked.components.find((component) => component.id === "wrapper");

  assert(ranked.components[0]?.id === "market-table", "Expected selected Figma context to rank the meaningful table above a generic flex wrapper.");
  assert(componentDisplayScore(wrapper) <= 64, "Expected generic wrappers to be capped below auto-confirm confidence.");
  assert(hasHardMatchWarning(wrapper), "Expected generic wrappers to require manual confirmation.");
}

function testRepoComponentRanking(): void {
  const indexHtml = `<div class="bg-neutral-secondary text-neutral-primary">Demo shell</div>`;
  const buttonVue = `
    <template>
      <button :class="classes">
        <span class="inline-flex items-center">Save</span>
      </button>
    </template>
    <script lang="ts">
    export default { name: 'NButton' };
    </script>
  `;
  const reference = parseProductionSource([
    file("packages/core/index.html", indexHtml),
    file("packages/core/src/components/Button/Button/src/NButton.vue", buttonVue)
  ], "repo-upload", "repo");

  assert(reference.components[0]?.name === "NButton", "Expected repo detection to prioritize real component files over index.html shells.");
}

function testJsThemeColorTokens(): void {
  const palette = `
    const colors = {
      white: "#fff",
      primary: { 70: "#18a15a", 90: "#17643d" },
      neutral: { 160: "#1e1d1d" }
    };
    module.exports = colors;
  `;
  const theme = `
    const colors = require("../../palette");
    const brand = {
      primary: {
        DEFAULT: colors.primary["70"],
        hover: colors.primary["90"],
      },
    };
    exports.backgroundColor = { brand };
  `;
  const reference = parseProductionSource([
    file("packages/tailwind-preset/palette/index.js", palette),
    file("packages/tailwind-preset/themes/light/background.js", theme)
  ], "repo-upload", "repo");

  assert(reference.tokens.some((token) => token.name === "primary-70" && token.value === "#18a15a"), "Expected nested JS palette colors to become named tokens.");
  assert(reference.tokens.some((token) => token.name === "background-brand-primary" && token.value === "#18a15a"), "Expected theme color aliases to become named tokens.");
  assert(reference.tokens.some((token) => token.name === "background-brand-primary-hover" && token.value === "#17643d"), "Expected theme state aliases to become named tokens.");
}

function testTokenNormalization(): void {
  assert(normalizeColor("rgb(26, 115, 232)") === "#1a73e8", "Expected rgb color to normalize to hex.");
  assert(normalizeColor("rgba(26, 115, 232, 0.5)") === "#1a73e880", "Expected rgba color to preserve alpha.");
  assert(valuesMatch("700", "bold", "typography"), "Expected numeric and named font weights to match.");
  assert(!valuesMatch("rgba(26, 115, 232, 0.5)", "#1a73e8", "color"), "Expected translucent color not to match opaque color.");
}

function testTokenMapping(): void {
  const reference = parseProductionSource([file("button.css", ":root { --space-md: 12px; --weight-bold: 700; } .button { padding: 8px 12px; font-weight: bold; }")], "production-file", "button.css");
  const index = createProductionTokenIndex(reference.tokens);
  const spacingToken = makeLayerToken("padding-right", "spacing", 12, "12px");
  const weightToken = makeLayerToken("font-weight", "typography", 700, "700");
  const weightMatch = mapFigmaTokenToProduction(weightToken, index);

  assert(mapFigmaTokenToProduction(spacingToken, index).status === "missing-token", "Expected 12px padding shorthand value to map to a production token.");
  assert(weightMatch.status === "missing-token", "Expected bold font weight to map to a production token.");
  assert(weightMatch.actualDisplay === "700", "Expected font-weight display to stay unitless.");
}

function makeLayerToken(field: LayerToken["field"], category: LayerToken["category"], value: LayerToken["value"], displayValue: string): LayerToken {
  return {
    id: `node:${field}`,
    nodeId: "node",
    nodeName: "Layer",
    nodePath: "Layer",
    nodeType: "FRAME",
    field,
    category,
    value,
    displayValue,
    hasStyleBinding: false,
    hasVariableBinding: false
  };
}
