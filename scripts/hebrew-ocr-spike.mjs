#!/usr/bin/env node
// M1 L21 Hebrew OCR spike — Azure Document Intelligence v4.0 (api-version 2024-11-30).
// See docs/spikes/hebrew-ocr-spike.md for provisioning, sample-prep, and decision criteria.
//
// Strategy: run each input image through BOTH `prebuilt-read` and `prebuilt-layout`,
// because Priority screenshots are form/tabular and layout returns structural fields
// (tables, selectionMarks) that read does not. Both models support printed Hebrew per
// https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/language-support-ocr
//
// Locale param is intentionally OMITTED by default — Microsoft's guidance is that forcing
// the language code can produce incomplete/incorrect text; auto-detection is preferred.
// Override via AZURE_DOCINTEL_LOCALE if you need to force (value: `he`, not `he-IL`).
//
// Output (all in spikes/hebrew-ocr/output/, gitignored except .gitkeep):
//   <name>.read.raw.json     full prebuilt-read API response
//   <name>.read.txt          extracted text (read)
//   <name>.layout.raw.json   full prebuilt-layout API response
//   <name>.layout.txt        extracted text (layout)
//   _summary.md              one row per (image × model): chars / mean line confidence / line count.
//                            NO text preview column — Priority screenshots have customer data; the
//                            summary is git-trackable signal-only.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const INPUT_DIR = join(REPO_ROOT, "spikes", "hebrew-ocr", "input");
const OUTPUT_DIR = join(REPO_ROOT, "spikes", "hebrew-ocr", "output");

const API_VERSION = "2024-11-30";
const MODELS = ["prebuilt-read", "prebuilt-layout"];
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;

const CONTENT_TYPE_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".bmp": "image/bmp",
  ".heif": "image/heif",
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    console.error(`See docs/spikes/hebrew-ocr-spike.md for provisioning.`);
    process.exit(1);
  }
  return v;
}

function normalizeEndpoint(raw) {
  return raw.replace(/\/+$/, "");
}

function redactEndpoint(endpoint) {
  // Strip the tenant subdomain so the summary doesn't leak the resource name
  // if a future user force-adds spikes/hebrew-ocr/output/_summary.md.
  return endpoint.replace(/^https?:\/\/[^/]+/, "https://<docintel-host>");
}

async function analyzeOne(endpoint, key, model, imagePath, contentType) {
  const url = new URL(`${endpoint}/documentintelligence/documentModels/${model}:analyze`);
  url.searchParams.set("api-version", API_VERSION);
  if (process.env.AZURE_DOCINTEL_LOCALE) {
    url.searchParams.set("locale", process.env.AZURE_DOCINTEL_LOCALE);
  }

  const body = await readFile(imagePath);
  const submitRes = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": contentType,
    },
    body,
  });

  if (submitRes.status !== 202) {
    const errBody = await submitRes.text();
    throw new Error(
      `Submit failed for ${basename(imagePath)} (${model}): HTTP ${submitRes.status}\n${errBody}`,
    );
  }

  const opLocation = submitRes.headers.get("operation-location");
  if (!opLocation) {
    throw new Error(`No Operation-Location header for ${basename(imagePath)} (${model})`);
  }

  const started = Date.now();
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(opLocation, {
      headers: { "Ocp-Apim-Subscription-Key": key },
    });
    if (!pollRes.ok) {
      const errBody = await pollRes.text();
      throw new Error(
        `Poll failed for ${basename(imagePath)} (${model}): HTTP ${pollRes.status}\n${errBody}`,
      );
    }
    const result = await pollRes.json();
    if (result.status === "succeeded") return result;
    if (result.status === "failed") {
      throw new Error(
        `Analysis failed for ${basename(imagePath)} (${model}): ${JSON.stringify(result.error ?? result)}`,
      );
    }
    // status === 'running' or 'notStarted' — keep polling
  }
  throw new Error(
    `Timeout waiting for ${basename(imagePath)} (${model}) after ${POLL_TIMEOUT_MS}ms`,
  );
}

function summarize(result, image, model) {
  const pages = result.analyzeResult?.pages ?? [];
  const allLines = pages.flatMap((p) => p.lines ?? []);
  const allWords = pages.flatMap((p) => p.words ?? []);
  const text = (result.analyzeResult?.content ?? "").trim();
  const confidences = allWords.map((w) => w.confidence).filter((c) => typeof c === "number");
  const meanConfidence =
    confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  return {
    image,
    model,
    chars: text.length,
    lineCount: allLines.length,
    wordCount: allWords.length,
    meanWordConfidence: meanConfidence,
    pageCount: pages.length,
  };
}

async function main() {
  const endpoint = normalizeEndpoint(requireEnv("AZURE_DOCINTEL_ENDPOINT"));
  const key = requireEnv("AZURE_DOCINTEL_KEY");

  await mkdir(OUTPUT_DIR, { recursive: true });

  let inputs;
  try {
    inputs = (await readdir(INPUT_DIR)).filter((f) => !f.startsWith("."));
  } catch (e) {
    console.error(`Cannot read ${INPUT_DIR}: ${e.message}`);
    console.error(`Drop sample screenshots into spikes/hebrew-ocr/input/ first.`);
    process.exit(1);
  }

  if (inputs.length === 0) {
    console.error(`No input files in ${INPUT_DIR}`);
    console.error(`See docs/spikes/hebrew-ocr-spike.md for the 5-screenshot stratification.`);
    process.exit(1);
  }

  const rows = [];
  for (const file of inputs) {
    const ext = extname(file).toLowerCase();
    const contentType = CONTENT_TYPE_BY_EXT[ext];
    if (!contentType) {
      console.error(`Skipping ${file} — unsupported extension ${ext}`);
      continue;
    }
    const imagePath = join(INPUT_DIR, file);
    const stem = basename(file, ext);
    for (const model of MODELS) {
      const modelTag = model.replace(/^prebuilt-/, "");
      process.stdout.write(`${file} × ${model}... `);
      try {
        const result = await analyzeOne(endpoint, key, model, imagePath, contentType);
        const rawPath = join(OUTPUT_DIR, `${stem}.${modelTag}.raw.json`);
        const txtPath = join(OUTPUT_DIR, `${stem}.${modelTag}.txt`);
        await writeFile(rawPath, JSON.stringify(result, null, 2), "utf8");
        await writeFile(txtPath, (result.analyzeResult?.content ?? "") + "\n", "utf8");
        const row = summarize(result, file, model);
        rows.push(row);
        console.log(
          `ok — ${row.chars} chars, ${row.lineCount} lines, mean word confidence ${row.meanWordConfidence.toFixed(3)}`,
        );
      } catch (err) {
        console.log(`FAIL`);
        console.error(`  ${err.message}`);
        rows.push({
          image: file,
          model,
          chars: 0,
          lineCount: 0,
          wordCount: 0,
          meanWordConfidence: 0,
          pageCount: 0,
          error: err.message.split("\n")[0].replace(/\|/g, "\\|"),
        });
      }
    }
  }

  const summaryLines = [
    "# Hebrew OCR spike — run summary",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Endpoint: ${redactEndpoint(endpoint)}  |  api-version: ${API_VERSION}`,
    `Locale override: ${process.env.AZURE_DOCINTEL_LOCALE ?? "(auto-detect — Azure recommended default)"}`,
    "",
    "Metrics only — no extracted-text previews (Priority screenshots contain customer data; previews would leak via git).",
    "Read the per-image `.txt` files locally to score against the decision criteria in `docs/spikes/hebrew-ocr-spike.md`.",
    "",
    "| Image | Model | Chars | Lines | Words | Mean word confidence | Notes |",
    "|-------|-------|------:|------:|------:|---------------------:|-------|",
    ...rows.map(
      (r) =>
        `| ${r.image} | ${r.model} | ${r.chars} | ${r.lineCount} | ${r.wordCount} | ${r.meanWordConfidence.toFixed(3)} | ${r.error ?? ""} |`,
    ),
    "",
  ];
  const summaryPath = join(OUTPUT_DIR, "_summary.md");
  await writeFile(summaryPath, summaryLines.join("\n"), "utf8");
  console.log(`\nSummary written: ${summaryPath}`);
  console.log(`Per-image .txt + .raw.json in: ${OUTPUT_DIR}`);
}

await main();
