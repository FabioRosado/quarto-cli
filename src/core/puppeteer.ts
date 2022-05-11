/*
* puppeteer.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { readRegistryKey } from "./windows.ts";
import { which } from "./path.ts";
import { warning } from "log/mod.ts";
import { fetcher } from "../command/tools/tools/chromium.ts";

// deno-lint-ignore no-explicit-any
let puppeteerImport: any = undefined;
// deno-lint-ignore prefer-const
let puppeteerUrl = "puppeteer/mod.ts";
export async function getPuppeteer() {
  if (puppeteerImport !== undefined) {
    return puppeteerImport;
  }
  puppeteerImport = (await import(puppeteerUrl)).default;
  return puppeteerImport;
}

export async function extractImagesFromElements(
  url: string | PageOptions,
  selector: string,
  filenames: string[],
): Promise<void> {
  await withPuppeteerBrowserAndPage(
    url,
    // deno-lint-ignore no-explicit-any
    async (_browser: any, page: any) => {
      const elements = await page.$$(selector);
      if (elements.length !== filenames.length) {
        throw new Error(
          `extractImagesFromElements was given ${filenames.length} filenames, but selector yielded ${elements.length} elements.`,
        );
      }
      for (let i = 0; i < elements.length; ++i) {
        await elements[i].screenshot({ path: filenames[i] });
      }
      return;
    },
  );
}

export function extractHtmlFromElements(
  url: string,
  selector: string,
): Promise<string[]> {
  // deno-lint-ignore no-explicit-any
  const document = (undefined as any);
  return inPuppeteer(url, (selector: string) => {
    // deno-lint-ignore no-explicit-any
    return Array.from(document.querySelectorAll(selector)).map((n: any) =>
      n.outerHTML
    );
  }, selector);
}

export interface PageOptions {
  url: string;
  viewport?: {
    // https://github.com/puppeteer/puppeteer/blob/v0.12.0/docs/api.md#pagesetviewportviewport
    width: number;
    height: number;
    deviceScaleFactor?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
    isLandscape?: boolean;
  };
}
export async function withPuppeteerBrowserAndPage<T>(
  url: string | PageOptions,
  // deno-lint-ignore no-explicit-any
  f: (b: any, p: any) => Promise<T>,
): Promise<T> {
  const allowedErrorMessages = [
    "Navigation failed because browser has disconnected!",
    "Navigation timeout of 30000 ms exceeded",
    "Evaluation failed: undefined",
  ];

  let attempts = 0;
  const maxAttempts = 5;
  while (attempts++ < maxAttempts) {
    try {
      let finished = false;
      let result: T;
      // deno-lint-ignore no-explicit-any
      await withHeadlessBrowser(async (browser: any) => {
        const page = await browser.newPage();
        if (typeof url === "string") {
          await page.goto(url);
        } else {
          if (url.viewport) {
            page.setViewport(url.viewport);
          }
          await page.goto(url.url);
        }
        result = await f(browser, page);
        finished = true;
      });
      if (finished) {
        return result!;
      }
    } catch (error) {
      if (
        (allowedErrorMessages.indexOf(error.message) !== -1) &&
        (attempts < maxAttempts)
      ) {
        console.log(
          `\nEncountered a bad error message from puppeteer: "${error.message}"\n Retrying ${attempts}/${maxAttempts}`,
        );
      } else {
        throw error;
      }
    }
  }
  throw new Error("Internal Error - shouldn't have arrived here.");
}

export async function inPuppeteer(
  url: string,
  // deno-lint-ignore no-explicit-any
  f: any,
  // deno-lint-ignore no-explicit-any
  ...params: any[]
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const allowedErrorMessages = [
    "Navigation failed because browser has disconnected!",
    "Navigation timeout of 30000 ms exceeded",
    "Evaluation failed: undefined",
  ];

  let attempts = 0;
  const maxAttempts = 5;
  while (attempts++ < maxAttempts) {
    try {
      // deno-lint-ignore no-explicit-any
      return await withHeadlessBrowser(async (browser: any) => {
        const page = await browser.newPage();
        await page.goto(url);
        const clientSideResult = await page.evaluate(f, ...params);
        return clientSideResult;
      });
    } catch (error) {
      if (
        (allowedErrorMessages.indexOf(error.message) !== -1) &&
        (attempts < maxAttempts)
      ) {
        console.log(
          `\nEncountered a bad error message from puppeteer: "${error.message}"\n Retrying ${attempts}/${maxAttempts}`,
        );
      } else {
        throw error;
      }
    }
  }
  throw new Error("Internal Error - shouldn't have arrived here.");
}

export async function withHeadlessBrowser<T>(
  // deno-lint-ignore no-explicit-any
  fn: (browser: any) => Promise<T>,
) {
  const browser = await fetchBrowser();
  if (browser !== undefined) {
    try {
      const result = await fn(browser);
      await browser.close();
      return result;
    } catch (e) {
      // we can't try ... finally here because it plays badly with async
      // and return values.
      await browser.close();
      throw e;
    }
  }
}

async function findChrome(): Promise<string | undefined> {
  let path;
  if (Deno.build.os === "darwin") {
    path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  } else if (Deno.build.os === "linux") {
    path = await which("google-chrome");
    if (!path) {
      path = await which("chromium-browser");
    }
  } else if (Deno.build.os === "windows") {
    // Try the HKLM key
    path = await readRegistryKey(
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
      "(Default)",
    );

    // Try the HKCR key
    if (!path) {
      path = await readRegistryKey(
        "HKCR\\ChromeHTML\\shell\\open\\command",
        "(Default)",
      );
    }
  }
  return path;
}

async function fetchBrowser() {
  // Cook up a new instance
  const browserFetcher = await fetcher();
  const availableRevisions = await browserFetcher.localRevisions();

  let executablePath: string | undefined = undefined;

  if (availableRevisions.length > 0) {
    // get the latest available revision
    availableRevisions.sort((a: string, b: string) => Number(b) - Number(a));
    const revision = availableRevisions[0];
    const revisionInfo = browserFetcher.revisionInfo(revision);
    executablePath = revisionInfo.executablePath;
  }

  if (executablePath === undefined) {
    executablePath = await findChrome();
  }

  if (executablePath === undefined) {
    warning(
      "Capturing of embedded web content disabled (chromium not installed)",
    );
    return undefined;
  }

  const puppeteer = await getPuppeteer();
  return await puppeteer.launch({
    product: "chrome",
    executablePath,
  });
}
