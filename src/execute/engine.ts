/*
* engine.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { extname, join } from "path/mod.ts";

import {
  partitionYamlFrontMatter,
  readYamlFromMarkdown,
} from "../core/yaml.ts";
import { dirAndStem } from "../core/path.ts";

import { PartitionedMarkdown } from "../core/pandoc/pandoc-partition.ts";
import { languagesInMarkdown } from "../core/jupyter/jupyter.ts";

import { Format } from "../config/format.ts";
import { Metadata, metadataAsFormat } from "../config/metadata.ts";
import {
  kEngine,
  kIncludeAfterBody,
  kIncludeBeforeBody,
  kIncludeInHeader,
} from "../config/constants.ts";

import { knitrEngine } from "./rmd.ts";
import { jupyterEngine } from "./jupyter/jupyter.ts";
import { markdownEngine } from "./markdown.ts";

export const kQmdExtensions = [".qmd"];

export interface ExecutionEngine {
  name: string;
  defaultExt: string;
  defaultYaml: (kernel?: string) => string[];
  validExtensions: () => string[];
  claimsExtension: (ext: string) => boolean;
  claimsLanguage: (language: string) => boolean;
  target: (
    file: string,
    quiet?: boolean,
  ) => Promise<ExecutionTarget | undefined>;
  metadata: (file: string) => Promise<Metadata>;
  partitionedMarkdown: (file: string) => Promise<PartitionedMarkdown>;
  execute: (options: ExecuteOptions) => Promise<ExecuteResult>;
  executeTargetSkipped?: (target: ExecutionTarget, format: Format) => void;
  dependencies: (options: DependenciesOptions) => Promise<DependenciesResult>;
  postprocess: (options: PostProcessOptions) => Promise<void>;
  canFreeze: boolean;
  keepFiles?: (input: string) => string[] | undefined;
  ignoreGlobs?: () => string[] | undefined;
  renderOnChange?: (input: string) => boolean;
  run?: (options: RunOptions) => Promise<void>;
}

// execution target (filename and context 'cookie')
export interface ExecutionTarget {
  source: string;
  input: string;
  data?: unknown;
}

// execute options
export interface ExecuteOptions {
  target: ExecutionTarget;
  format: Format;
  resourceDir: string;
  tempDir: string;
  dependencies: boolean;
  libDir?: string;
  cwd?: string;
  params?: { [key: string]: unknown };
  quiet?: boolean;
}

// result of execution
export interface ExecuteResult {
  markdown: string;
  supporting: string[];
  filters: string[];
  dependencies?: {
    type: "includes" | "dependencies";
    data: PandocIncludes | Array<unknown>;
  };
  preserve?: Record<string, string>;
  postProcess?: boolean;
}

export interface PandocIncludes {
  [kIncludeBeforeBody]?: string;
  [kIncludeAfterBody]?: string;
  [kIncludeInHeader]?: string;
}

// dependencies options
export interface DependenciesOptions {
  target: ExecutionTarget;
  format: Format;
  output: string;
  resourceDir: string;
  tempDir: string;
  libDir?: string;
  dependencies?: Array<unknown>;
  quiet?: boolean;
}

// dependencies result
export interface DependenciesResult {
  includes: PandocIncludes;
}

// post processing options
export interface PostProcessOptions {
  engine: ExecutionEngine;
  target: ExecutionTarget;
  format: Format;
  output: string;
  preserve?: Record<string, string>;
  quiet?: boolean;
}

// run options
export interface RunOptions {
  input: string;
  render: boolean;
  port?: number;
  quiet?: boolean;
}

const kEngines: ExecutionEngine[] = [
  knitrEngine,
  jupyterEngine,
  markdownEngine,
];

export function executionEngines() {
  return kEngines.map((engine) => engine.name);
}

export function executionEngine(name: string) {
  // try to find an engine
  for (const engine of kEngines) {
    if (engine.name === name) {
      return engine;
    }
  }
}

export function executionEngineKeepMd(
  input: string,
  keepMd: (boolean | string | undefined),
): (string | undefined) {
  const keepSuffix = `.md`;
  let filename: string;

  // the logic here is a little strange, but since the goal of
  // executionEngineKeepMd is to create the filename rather than
  // decide on whether or not to actually keep the md file, this
  // function behaves the same if keepMd is a boolean or undefined and
  // only does something different if keepMd is a string

  if (keepMd === false || keepMd === true || keepMd === undefined) {
    filename = input;
  } else {
    // keepMd is a string, we take that to mean the desired file name
    filename = keepMd;
  }
  console.log("executionEngineKeepMd", { input, keepMd, filename });

  if (!input.endsWith(keepSuffix)) {
    const [dir, stem] = dirAndStem(filename);
    return join(dir, stem + keepSuffix);
  }
}

export function executionEngineKeepFiles(
  engine: ExecutionEngine,
  input: string,
) {
  // standard keepMd
  const files: string[] = [];

  // FIXME we don't have access to the keepMd option here so this one is likely wrong.
  const keep = executionEngineKeepMd(input);
  if (keep) {
    files.push(keep);
  }

  // additional files
  const engineKeepFiles = engine.keepFiles
    ? engine.keepFiles(input)
    : undefined;
  if (engineKeepFiles) {
    return files.concat(engineKeepFiles);
  } else {
    return files;
  }
}

export function fileExecutionEngine(file: string) {
  // get the extension and validate that it can be handled by at least one of our engines
  const ext = extname(file).toLowerCase();
  if (!kEngines.some((engine) => engine.validExtensions().includes(ext))) {
    return undefined;
  }

  // try to find an engine that claims this extension outright
  for (const engine of kEngines) {
    if (engine.claimsExtension(ext)) {
      return engine;
    }
  }

  // read yaml and see if the engine is declared in yaml
  // (note that if the file were a non text-file like ipynb
  //  it would have already been claimed via extension)
  const markdown = Deno.readTextFileSync(file);
  const result = partitionYamlFrontMatter(markdown);
  if (result) {
    const yaml = readYamlFromMarkdown(result.yaml);
    if (yaml) {
      for (const engine of kEngines) {
        if (yaml[engine.name]) {
          return engine;
        }
        const format = metadataAsFormat(yaml);
        if (
          format.execute?.[kEngine] === engine.name
        ) {
          return engine;
        }
      }
    }
  }

  // if there are languages see if any engines want to claim them
  const languages = languagesInMarkdown(markdown);
  if (languages.size > 0) {
    for (const language of languages) {
      for (const engine of kEngines) {
        if (engine.claimsLanguage(language)) {
          return engine;
        }
      }
    }

    // if there is no language or just ojs then it's plain markdown
    if (languages.size === 0 || (languages.size == 1 && languages.has("ojs"))) {
      return markdownEngine;
    } else {
      return jupyterEngine;
    }
  } else {
    // no languages so use plain markdown
    return markdownEngine;
  }
}

export function engineIgnoreGlobs() {
  const ignoreGlobs: string[] = [];
  executionEngines().forEach((name) => {
    const engine = executionEngine(name);
    if (engine && engine.ignoreGlobs) {
      const engineIgnores = engine.ignoreGlobs();
      if (engineIgnores) {
        ignoreGlobs.push(...engineIgnores);
      }
    }
  });
  return ignoreGlobs;
}
