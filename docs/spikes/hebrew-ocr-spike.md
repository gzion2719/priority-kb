# Hebrew OCR spike — Azure Document Intelligence (M1 L21)

**One-day spike** answering ADR-0001 §89's #1 unknown: *is Azure Document Intelligence good enough at printed Hebrew on real Priority screenshots that we can commit to the M2b OCR pipeline plan?*

Output: a yes/no decision recorded in [`docs/BACKLOG.md`](../BACKLOG.md) under "Ingestion → Stronger Hebrew OCR", with concrete numbers. If "yes" — M2b OCR pipeline stays Azure-first. If "no" — fallback tree at the bottom of this doc kicks in.

This is **not** a production wiring exercise. The M2b production OCR worker is Python ([ROADMAP M2b L80](../ROADMAP.md)); this spike is Node-only to keep the M1 toolchain consistent.

---

## What's verified up front (from Microsoft's docs, 2026-05-17)

- `prebuilt-read` and `prebuilt-layout` both support **printed Hebrew (`he`)** on api-version `2024-11-30`. Confirmed in the [language-support matrix](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/language-support-ocr).
- Handwritten Hebrew is **not** supported (only en / zh-Hans / fr / de / it / ja / ko / pt / es / ru / th / ar). Priority screenshots are printed UI, so this doesn't bite.
- Microsoft **recommends omitting** the `locale` parameter: *"Don't provide the language code as the parameter unless you are sure of the language and want to force the service to apply only the relevant model. Otherwise, the service may return incomplete and incorrect text."* The script honors this by default; override with `AZURE_DOCINTEL_LOCALE=he` if you want to test the forced path.
- The free **F0 tier** covers 500 pages/month — 5 screenshots × 2 models = 10 calls, well inside the quota.

---

## Provisioning (5 min)

1. Azure portal → **Create a resource** → search "Document Intelligence" → Create.
2. Pick a resource group, region (`westeurope` is fine for Israel), pricing tier **F0 (free)**.
3. After deploy: **Keys and Endpoint** blade. Copy:
   - **Endpoint** → `AZURE_DOCINTEL_ENDPOINT` (e.g., `https://priority-kb-docintel.cognitiveservices.azure.com`)
   - **KEY 1** → `AZURE_DOCINTEL_KEY`

**Do not commit these.** They go in your shell env only. The repo has no `.env` mechanism for this spike — env vars at invocation time.

---

## Sample data prep — the 5 strata

To make the spike generalize, the 5 screenshots must each cover a different shape Priority renders. Drop them into `spikes/hebrew-ocr/input/` (gitignored; nothing tracked except the `.gitkeep` anchor).

| # | Stratum | What to grab | Why |
|---|---------|--------------|-----|
| 1 | **Labeled form** | A screen with field labels next to input values (customer form / item card / order header) | Tests form-label association — the most common Priority shape. |
| 2 | **Tabular report** | A grid/report screen with multiple rows + columns of Hebrew data | Tests table extraction (where `prebuilt-layout` adds value over `prebuilt-read`). |
| 3 | **Error / dialog** | A modal or banner with a Hebrew error message | Short text, often the highest-stakes "we need this right" content. |
| 4 | **Button-heavy toolbar / ribbon** | A toolbar with multiple Hebrew button labels | Tests short-label OCR; many false negatives hide here. |
| 5 | **Mixed Hebrew + English + numbers** | A screen with all three (a typical order with SKU codes + Hebrew names + ₪ amounts) | Tests RTL/LTR boundary handling and the inversion failure mode. |

Save as PNG or JPEG. Reasonable file naming: `01-form.png`, `02-report.png`, etc.

---

## Invocation

```powershell
$env:AZURE_DOCINTEL_ENDPOINT = "https://<your-resource>.cognitiveservices.azure.com"
$env:AZURE_DOCINTEL_KEY = "<your-key-1>"
# Optional: force locale instead of auto-detect (Azure recommends auto)
# $env:AZURE_DOCINTEL_LOCALE = "he"

node scripts/hebrew-ocr-spike.mjs
```

Per image you'll get 4 files in `spikes/hebrew-ocr/output/` (all gitignored):
- `<name>.read.raw.json` — full `prebuilt-read` response
- `<name>.read.txt` — extracted text only
- `<name>.layout.raw.json` — full `prebuilt-layout` response (adds `tables` + `selectionMarks`)
- `<name>.layout.txt` — extracted text only

Plus one `_summary.md` with chars / lines / words / mean word confidence per (image × model). It's gitignored alongside the other outputs; the endpoint subdomain is redacted in the header so a future force-add wouldn't leak the tenant resource name. **No text previews in the summary** — Priority screenshots have customer data, and previews would leak via git. Read the local `.txt` files for content.

---

## Decision criteria — score before celebrating

Run the script, then for each image score against ALL of the following. Write the per-image numbers into [`docs/BACKLOG.md`](../BACKLOG.md) "Stronger Hebrew OCR" entry (expanded). The spike is a **pass** only if every criterion clears on at least 4 of the 5 images.

| # | Criterion | Threshold | How to score |
|---|-----------|----------:|--------------|
| 1 | **Character recall** | ≥ 90% | Manually transcribe ground truth for each image. Count characters in ground truth (`G`) and characters present in the OCR `.txt` (`P`). Recall = chars-in-common / `G`. Use whichever model (read or layout) scored higher per image. |
| 2 | **Mean word confidence** | ≥ 0.85 | From `_summary.md` — `meanWordConfidence` column. Per (image × model). |
| 3 | **RTL inversion test** | Pass | Pick image #5 (Hebrew + English + numbers). Identify a known LTR substring (e.g., a Priority form code like `ORDDOC`, an SKU, an English word). Grep the `.txt` — the substring must appear **intact and not character-reversed**. (`COCDRO` = fail.) |
| 4 | **Form-label association** | Pass | On image #1 (labeled form): open the `.layout.raw.json`. Field labels should appear in line ordering **adjacent to** (within ±2 lines of) their values. If labels and values are scattered randomly, layout has not preserved the visual association. |

Scoring sheet template (paste into the BACKLOG entry):

```
Image 1 (form):     recall=__%  conf=____  rtl=__   label-assoc=__
Image 2 (report):   recall=__%  conf=____  rtl=N/A  label-assoc=N/A
Image 3 (error):    recall=__%  conf=____  rtl=N/A  label-assoc=N/A
Image 4 (toolbar):  recall=__%  conf=____  rtl=N/A  label-assoc=N/A
Image 5 (mixed):    recall=__%  conf=____  rtl=__   label-assoc=N/A
PASS / FAIL: ___    Notes: ___
```

---

## Fallback tree (if Azure fails)

In order of effort to swap in:

1. **`prebuilt-layout` already in the script** — if `prebuilt-read` extraction is weaker than layout on most images, the M2b plan becomes "layout-only" (slightly slower per call, but better signal). Cheap.
2. **Google Document AI** — comparable cloud OCR, separate quality + pricing curve. Spike again (1 day) with the same 5 images.
3. **Tesseract `+heb`** — local, open-source. Lower ceiling on quality but no API cost and no upload-to-cloud concern. Spike again (1 day); compare against Azure's best.
4. **Hybrid: Azure for structure, Tesseract for fallback** — runs both, picks the higher-confidence per region. M2b complexity bump.

The decision tree itself goes in BACKLOG when this spike completes.

---

## Where results land

After running and scoring, expand the existing [`docs/BACKLOG.md`](../BACKLOG.md) entry under **Ingestion → Stronger Hebrew OCR**:

- Replace the placeholder bullet with the scoring sheet above + a PASS/FAIL verdict + a one-paragraph qualitative note (what surprised you, what's the failure mode).
- If PASS: add a short follow-up item — "wire `prebuilt-layout` into the M2b OCR pipeline; deferred screening tests until M2b lands."
- If FAIL: add the fallback decision + a new follow-up item for the next spike.

Then tick [`docs/ROADMAP.md`](../ROADMAP.md) M1 L21 with a reference to the BACKLOG entry.

---

## What this spike is NOT

- Not a reusable component — the script is single-purpose and disposable. M2b's production OCR pipeline is Python ([ROADMAP M2b L80](../ROADMAP.md)).
- Not a quality benchmark across providers — only Azure. If Azure passes, we stop. If it fails, run a sibling spike for the next provider.
- Not load testing — 5 images is enough to make the "is this fundamentally viable" call. Volume/cost characterization is M2b.
- Not a security review — uploading customer screenshots to Azure is fine for the spike (transient analysis, no data persistence on Azure's side per their terms). M5 will revisit data-residency posture.
