---
name: Focus card validation fix
overview: Wire main_cards.csv and correlation_cards-2.csv into populate-health-report.mjs as the authoritative text sources for all 7 focus cards, and implement the Tier 5 supplement priority assignment algorithm.
todos:
  - id: parse-csvs
    content: Add parseCsv() helper and load both main_cards.csv and correlation_cards-2.csv at startup in populate-health-report.mjs
    status: pending
  - id: lookup-helpers
    content: Add mainCardText(metric, graph, version) lookup helper using the parsed CSV rows
    status: pending
  - id: fix-buildFocusSlot
    content: Replace hardcoded fallbacks in buildFocusSlotFromFm for non-correlation / Tier 5 cards with mainCardText() calls
    status: pending
  - id: fix-extension-slots
    content: Replace hardcoded static strings in focusExtensionSlots with mainCardText() lookups for systems, energy, inflammation
    status: pending
  - id: tier5-supplement-algo
    content: Implement Tier 5 supplement priority assignment algorithm and apply it across all four Tier 5 graph slots
    status: pending
  - id: rebuild
    content: Run node populate-health-report.mjs and verify all 7 cards use correct text sources and supplements
    status: pending
isProject: false
---

# Focus card text-source and supplement validation

## Validation table (current state)

| Card | Metric | Card type | Text source (actual) | Text source (required) | Current title | Expected title | Supplement (actual) | Supplement (expected) | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | HRV | Non-correlation | Hardcoded fallback | `main_cards.csv` | "Support nightly recovery" | "Improve Baseline HRV" | Iron (unused) | N/A | FAIL — wrong source |
| 2 | Disruptions | Non-correlation | Hardcoded fallback | `main_cards.csv` | "Reduce sleep disruptions" | "Improve Sleep Continuity" | Probiotics (unused) | N/A | FAIL — wrong source |
| 3 | RHR | **Correlation** | `correlationCardsResolved` ← `correlation_cards-2.csv` | `correlation_cards-2.csv` | "Improve recovery quality…" | "Improve recovery quality…" | Vitamin E (unused) | N/A | **PASS ✓** |
| 4 | healthspan | Non-correlation / Tier 5 | Hardcoded fallback | `main_cards.csv` | "Invest in long-term healthspan" | "Protect long-term healthspan" | Magnesium | Magnesium | FAIL — wrong title; supplement PASS |
| 5 | extension\_system\_decline | Non-correlation / Tier 5 | Hardcoded static string | `main_cards.csv` | "How systems age together" | "Preserve whole-body function" | None | Vitamin B12 | FAIL — wrong title + no supplement |
| 6 | extension\_energy\_age | Non-correlation / Tier 5 | Hardcoded static string | `main_cards.csv` | "Energy across the lifespan" | "Protect long-term energy" | None | CoQ10 | FAIL — wrong title + no supplement |
| 7 | extension\_inflammation | Non-correlation / Tier 5 | Hardcoded static string | `main_cards.csv` | "Inflammation and longevity" | "Preserve long-term resilience" | None | Ashwagandha | FAIL — wrong title + no supplement |

**Summary: 1 PASS, 6 FAIL**

---

## Two independent layers — the key principle

```
TEXT   = f(metric, graph, version)    → main_cards.csv     (for all non-correlation cards)
SUPP   = f(priority order, free slots) → supplement algorithm (Tier 5 only)
```

These two lookups must never share inputs. The supplement assigned to a Tier 5 slot does **not** influence which CSV row is selected for that slot's title/copy/how_it_works.

---

## Updated validation table

| Card | Metric | Type | Text lookup key | Expected title (main_cards.csv) | Supplement (expected) | Supplement (actual) | Text status | Supplement status |
|---|---|---|---|---|---|---|---|---|
| 1 | HRV | Non-corr | `hrv + cohort + baseline` | "Improve Baseline HRV" | N/A | — | FAIL | N/A |
| 2 | Disruptions | Non-corr | `sleep_disruptions + cohort + baseline` | "Improve Sleep Continuity" | N/A | — | FAIL | N/A |
| 3 | RHR | Correlation | `correlation_cards-2.csv` row (csvKey match) | "Improve recovery quality…" | N/A | — | PASS ✓ | N/A |
| 4 | healthspan | Tier 5 | `healthspan + healthspan + NA` | "Protect long-term healthspan" | Magnesium | Magnesium | FAIL | PASS ✓ |
| 5 | ext\_system\_decline | Tier 5 | `healthspan + systems + NA` | "Preserve whole-body function" | Vitamin B12 | None | FAIL | FAIL |
| 6 | ext\_energy\_age | Tier 5 | `healthspan + energy + NA` | "Protect long-term energy" | CoQ10 | None | FAIL | FAIL |
| 7 | ext\_inflammation | Tier 5 | text: `healthspan + inflammation + NA` · supp slot: `oxidative_stress` | "Preserve long-term resilience" | Ashwagandha | None | FAIL | FAIL |

---

## What needs to change in [`populate-health-report.mjs`](populate-health-report.mjs)

### 1 — Parse both CSVs at startup

```js
// After existing readJson calls
const mainCardsRows = parseCsv(
  fs.readFileSync(path.join(root, 'correlation_cards - main_cards.csv'), 'utf8')
);
```

`main_cards.csv` columns: `metric, graph, version, title, copy, how_it_works`

Correlation cards are already satisfied via `correlationCardsResolved` — no change needed.

### 2 — Add `mainCardText(metric, graph, version, cardIndex)` lookup

```js
function mainCardText(metric, graph, version, cardIndex) {
  const row = mainCardsRows.find(
    r => r.metric === metric && r.graph === graph && r.version === version
  );
  if (!row) {
    throw new Error(
      `[Card ${cardIndex}] mainCardText lookup failed — no row matched ` +
      `metric="${metric}" graph="${graph}" version="${version}" in main_cards.csv`
    );
  }
  return { title: row.title, summary: row.copy, why: row.how_it_works };
}
```

Silent fallback to hardcoded text is not allowed. A missing row is a hard error that must be fixed in `main_cards.csv` or in the lookup arguments before the build can proceed.

### 3 — Layer A: Text resolution — replace all hardcoded text with CSV lookups

#### `buildFocusSlotFromFm` (cards 1–4)

In the `else if (metric === 'healthspan' || fm.tier === 5)` branch and the `else` switch:
- Replace hardcoded strings with `mainCardText(csvMetric, graphType, derivedVersion)`
- For cards 1 and 2, `derivedVersion` comes from the user's cohort standing (already computed in the file as compared values against normative benchmarks):
  - Below demographic average → `'baseline'`
  - Above average, below top 10% → `'top 10%'`
  - Top 10%, high variance → `'unstable'`
  - Top 10%, low variance → `'variable'`
- For Tier 5 cards, `version = 'NA'`

The `csvMetric` for Tier 5 card 4 is `healthspan`; for cards 1–2 it maps from their metric tag (e.g. `hrv`, `sleep_disruptions`).

#### `focusExtensionSlots` (cards 5–7)

Replace every static `title`, `summary`, `cap`, `why` string with `mainCardText(...)`:

| Slot | `metric` | `graph` (CSV key) | `version` |
|---|---|---|---|
| Card 5 | `healthspan` | `systems` | `NA` |
| Card 6 | `healthspan` | `energy` | `NA` |
| Card 7 | `healthspan` | **`inflammation`** | `NA` |

### 4 — Layer B: Supplement assignment (Tier 5 only, independent of text)

After text is resolved, run the priority algorithm across the four Tier 5 supplement slots.

**Critical mapping — Card 7 uses two different keys that must never be conflated:**

| Dimension | Key used | Source |
|---|---|---|
| Text lookup (Layer A) | `inflammation` | `main_cards.csv` `graph` column |
| Supplement slot (Layer B) | `oxidative_stress` | Supplement priority table |

This mapping must be explicit in code — for example:

```js
const TIER5_SUPPLEMENT_SLOT_KEY = {
  healthspan:  'healthspan',
  systems:     'systems',
  energy:      'energy',
  inflammation: 'oxidative_stress',   // CSV graph key → supplement slot key
};
```

Layer B runs against the supplement slot keys (`oxidative_stress`), never against the CSV graph keys directly.

```
Supplement priority (slot keys):
  Magnesium          → [healthspan, oxidative_stress]
  Vitamin B12        → [healthspan, systems]
  Probiotics         → [healthspan, systems]
  Ashwagandha        → [healthspan, oxidative_stress]
  CoQ10              → [healthspan, energy]
  Resveratrol        → [healthspan, energy]
  Acetyl L-Carnitine → [healthspan, energy]
  Omega 3            → [healthspan, oxidative_stress]
  Vitamin D          → [healthspan, systems]
```

Expected result:
- healthspan → **Magnesium**
- systems → **Vitamin B12**
- energy → **CoQ10**
- oxidative\_stress → **Ashwagandha**

The assigned supplement is stored on the slot as `slot.assignedSupplement` and injected into the card separately from title/copy/why — for example as a badge or secondary line in `summary_html`.

### 5 — Rebuild and verify

`node populate-health-report.mjs` — check that each of the 7 cards has:
- title matching the expected CSV row
- correct supplement badge (Tier 5 only)
- no mixing of supplement name into the title/copy text
