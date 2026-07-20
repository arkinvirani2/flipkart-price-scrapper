/**
 * Public entry point + CLI.
 *
 *   npm run scrape -- --url "<productUrl>" --seller "AYANSHENTERPRISEE" --sku SKU1 --fsn FSN1
 *   npm run scrape -- --file inputs.json --out results.json --headed
 *
 * `inputs.json` is an array of { productUrl, targetSeller, sku, fsn }.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { scrapeProduct, scrapeProducts } from './scraper';
import type { ScrapeInput, ScrapeResult, ScraperOptions } from './types';

export { scrapeProduct, scrapeProducts } from './scraper';
export * from './types';
export { comparePrice, parsePrice, normalizeSellerName, sellerNamesMatch } from './parser';

/* -------------------------------------------------------------------- CLI */

interface CliArgs {
  url?: string;
  seller?: string;
  sku?: string;
  fsn?: string;
  file?: string;
  out?: string;
  headed: boolean;
  quiet: boolean;
  timeout?: number;
  maxShowMore?: number;
  noNetwork: boolean;
  screenshotDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { headed: false, quiet: false, noNetwork: false };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => argv[++i];

    switch (flag) {
      case '--url': args.url = next(); break;
      case '--seller': args.seller = next(); break;
      case '--sku': args.sku = next(); break;
      case '--fsn': args.fsn = next(); break;
      case '--file': args.file = next(); break;
      case '--out': args.out = next(); break;
      case '--headed': args.headed = true; break;
      case '--quiet': args.quiet = true; break;
      case '--timeout': args.timeout = Number(next()); break;
      case '--max-show-more': args.maxShowMore = Number(next()); break;
      case '--no-network': args.noNetwork = true; break;
      case '--screenshot-dir': args.screenshotDir = next(); break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (flag.startsWith('--')) {
          console.error(`Unknown flag: ${flag}`);
          printUsage();
          process.exit(2);
        }
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`
Flipkart seller price comparison

  Single product:
    npm run scrape -- --url "<productUrl>" --seller "<sellerName>" --sku "<sku>" --fsn "<fsn>"

  Batch:
    npm run scrape -- --file inputs.json [--out results.json]

  Options:
    --headed              Run with a visible browser (useful for debugging).
    --quiet               Suppress progress logs; print only the JSON result.
    --timeout <ms>        Per-action timeout. Default 20000.
    --max-show-more <n>   Runaway guard on "Show More" clicks. Default 40.
    --no-network          Skip network payload capture; DOM scraping only.
    --screenshot-dir <d>  Write a screenshot here when a product fails.
`);
}

function toOptions(args: CliArgs): ScraperOptions {
  return {
    headless: !args.headed,
    verbose: !args.quiet,
    timeout: args.timeout,
    maxShowMoreClicks: args.maxShowMore,
    useNetworkCapture: !args.noNetwork,
    screenshotOnFailureDir: args.screenshotDir,
  };
}

function loadInputs(path: string): ScrapeInput[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON array of { productUrl, targetSeller, sku, fsn }.`);
  }
  return parsed as ScrapeInput[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const options = toOptions(args);
  let results: ScrapeResult[];

  if (args.file) {
    results = await scrapeProducts(loadInputs(args.file), options);
  } else if (args.url && args.seller) {
    const input: ScrapeInput = {
      productUrl: args.url,
      targetSeller: args.seller,
      sku: args.sku ?? '',
      fsn: args.fsn ?? '',
    };
    results = [await scrapeProduct(input, options)];
  } else {
    printUsage();
    process.exit(2);
    return;
  }

  const json = JSON.stringify(args.file ? results : results[0], null, 2);
  if (args.out) {
    writeFileSync(args.out, json, 'utf8');
    if (!args.quiet) console.log(`\nWrote ${results.length} result(s) to ${args.out}`);
  } else {
    console.log(`\n${json}`);
  }

  // Non-zero exit when nothing succeeded, so CI and shell callers can branch.
  process.exit(results.some((r) => r.status === 'OK') ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
