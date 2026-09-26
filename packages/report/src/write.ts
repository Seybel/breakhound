import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScanResult } from '@breakhound/engine';
import { groupIssues } from './format';
import { renderHtml } from './html';
import { renderDetailed, renderPrompt, renderSummary } from './markdown';

export interface WriteOptions {
  /** Folder holding the issue screenshots, relative paths in Markdown point here. */
  screenshotDir?: string;
  /** Also print the HTML report to PDF. */
  pdf?: boolean;
  verifyCommand?: string;
}

export interface WrittenReports {
  json: string;
  summary: string;
  markdown: string;
  html: string;
  prompt: string;
  pdf?: string;
}

/** Screenshots shown in the HTML report: one per unique issue, from the first page it was found on. */
function loadImages(result: ScanResult, dir: string | undefined): Map<string, string> {
  const images = new Map<string, string>();
  if (!dir) return images;
  for (const { issue } of groupIssues(result)) {
    if (!issue.screenshot) continue;
    const file = join(dir, issue.screenshot);
    if (existsSync(file)) {
      images.set(
        issue.screenshot,
        `data:image/png;base64,${readFileSync(file).toString('base64')}`,
      );
    }
  }
  return images;
}

/** Writes every report format into `outDir` and returns their paths. */
export async function writeReports(
  result: ScanResult,
  outDir: string,
  options: WriteOptions = {},
): Promise<WrittenReports> {
  mkdirSync(outDir, { recursive: true });
  const promptOptions = options.verifyCommand ? { verifyCommand: options.verifyCommand } : {};
  const paths: WrittenReports = {
    json: join(outDir, 'result.json'),
    summary: join(outDir, 'summary.md'),
    markdown: join(outDir, 'report.md'),
    html: join(outDir, 'report.html'),
    prompt: join(outDir, 'prompt.md'),
  };
  writeFileSync(paths.json, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(paths.summary, renderSummary(result));
  writeFileSync(paths.markdown, renderDetailed(result, 'screenshots/'));
  writeFileSync(paths.prompt, renderPrompt(result, promptOptions));
  const html = renderHtml(result, {
    images: loadImages(result, options.screenshotDir),
    ...promptOptions,
  });
  writeFileSync(paths.html, html);

  if (options.pdf) {
    paths.pdf = join(outDir, 'report.pdf');
    await printPdf(html, paths.pdf);
  }
  return paths;
}

async function printPdf(html: string, file: string): Promise<void> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1200 } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print', colorScheme: 'light' });
    await page.pdf({
      path: file,
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await browser.close();
  }
}
