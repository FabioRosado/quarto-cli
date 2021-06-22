/*
* jupyter.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { extname, join } from "path/mod.ts";

import { existsSync } from "fs/mod.ts";

import { readYamlFromMarkdown } from "../../core/yaml.ts";
import { isInteractiveSession } from "../../core/platform.ts";
import { partitionMarkdown } from "../../core/pandoc/pandoc-partition.ts";

import { dirAndStem, removeIfExists } from "../../core/path.ts";
import { runningInCI } from "../../core/ci-info.ts";

import {
  DependenciesOptions,
  ExecuteOptions,
  ExecuteResult,
  ExecutionEngine,
  ExecutionTarget,
  kQmdExtensions,
  PandocIncludes,
  PostProcessOptions,
} from "../engine.ts";
import {
  isJupyterNotebook,
  jupyterAssets,
  jupyterFromFile,
  jupyterToMarkdown,
  kJupyterNotebookExtensions,
  quartoMdToJupyter,
} from "../../core/jupyter/jupyter.ts";
import {
  kExecuteDaemon,
  kExecuteEnabled,
  kExecuteIpynb,
  kFigDpi,
  kFigFormat,
  kIncludeAfterBody,
  kIncludeInHeader,
  kKeepHidden,
  kKeepIpynb,
  kPreferHtml,
} from "../../config/constants.ts";
import {
  Format,
  isHtmlOutput,
  isLatexOutput,
  isMarkdownOutput,
} from "../../config/format.ts";
import { restorePreservedHtml } from "../../core/jupyter/preserve.ts";

import {
  executeKernelKeepalive,
  executeKernelOneshot,
} from "./jupyter-kernel.ts";
import {
  includesForJupyterWidgetDependencies,
  JupyterWidgetDependencies,
} from "../../core/jupyter/widgets.ts";

import { RenderOptions } from "../../command/render/render.ts";
import { kMdExtensions } from "../markdown.ts";

const kJupyterEngine = "jupyter";

export const jupyterEngine: ExecutionEngine = {
  name: kJupyterEngine,

  defaultExt: ".qmd",

  defaultYaml: (kernel?: string) => [
    `jupyter: ${kernel || "python3"}`,
  ],

  validExtensions: () =>
    kJupyterNotebookExtensions.concat(kQmdExtensions, kMdExtensions),

  claimsExtension: (ext: string) => {
    return kJupyterNotebookExtensions.includes(ext.toLowerCase());
  },

  claimsLanguage: (_language: string) => {
    return false;
  },

  target: async (
    file: string,
  ): Promise<ExecutionTarget | undefined> => {
    // get the metadata
    const metadata = await metadataFromInputFile(file);

    // if this is a text markdown file then create a notebook for use as the execution target
    if (isQmdFile(file)) {
      // write a transient notebook
      const [fileDir, fileStem] = dirAndStem(file);
      const notebook = join(fileDir, fileStem + ".ipynb");
      const target = {
        source: file,
        input: notebook,
        metadata,
        data: { transient: true },
      };
      await createNotebookforTarget(target);
      return target;
    } else if (isJupyterNotebook(file)) {
      return {
        source: file,
        input: file,
        metadata,
        data: { transient: false },
      };
    } else {
      return undefined;
    }
  },

  partitionedMarkdown: async (file: string) => {
    if (isJupyterNotebook(file)) {
      return partitionMarkdown(await markdownFromNotebook(file));
    } else {
      return partitionMarkdown(Deno.readTextFileSync(file));
    }
  },

  filterFormat: (source: string, options: RenderOptions, format: Format) => {
    if (isJupyterNotebook(source)) {
      // see if we want to override execute enabled
      let executeEnabled: boolean | null | undefined;

      // we never execute for a dev server reload
      if (options.devServerReload) {
        executeEnabled = false;

        // if a specific ipynb execution policy is set then reflect it
      } else if (typeof (format.execute[kExecuteIpynb]) === "boolean") {
        executeEnabled = format.execute[kExecuteIpynb];
      }

      // if we had an override then return a format with it
      if (executeEnabled !== undefined) {
        return {
          ...format,
          execute: {
            ...format.execute,
            [kExecuteEnabled]: executeEnabled,
          },
        };
        // otherwise just return the original format
      } else {
        return format;
      }
      // not an ipynb
    } else {
      return format;
    }
  },

  execute: async (options: ExecuteOptions): Promise<ExecuteResult> => {
    // create the target input if we need to (could have been removed
    // by the cleanup step of another render in this invocation)
    if (isQmdFile(options.target.source) && !existsSync(options.target.input)) {
      await createNotebookforTarget(options.target);
    }

    // determine execution behavior
    const execute = options.format.execute[kExecuteEnabled] !== false;
    if (execute) {
      // jupyter back end requires full path to input (to ensure that
      // keepalive kernels are never re-used across multiple inputs
      // that happen to share a hash)
      const execOptions = {
        ...options,
        target: {
          ...options.target,
          input: Deno.realPathSync(options.target.input),
        },
      };

      // use daemon by default if we are in an interactive session (terminal
      // or rstudio) and not running in a CI system.
      let executeDaemon = options.format.execute[kExecuteDaemon];
      if (executeDaemon === null || executeDaemon === undefined) {
        executeDaemon = isInteractiveSession() && !runningInCI();
      }
      if (executeDaemon === false || executeDaemon === 0) {
        await executeKernelOneshot(execOptions);
      } else {
        await executeKernelKeepalive(execOptions);
      }
    }

    // convert to markdown and write to target
    const nb = jupyterFromFile(options.target.input);
    const assets = jupyterAssets(
      options.target.input,
      options.format.pandoc.to,
    );
    // NOTE: for perforance reasons the 'nb' is mutated in place
    // by jupyterToMarkdown (we don't want to make a copy of a
    // potentially very large notebook) so should not be relied
    // on subseuqent to this call
    const result = jupyterToMarkdown(
      nb,
      {
        language: nb.metadata.kernelspec.language,
        assets,
        execute: options.format.execute,
        keepHidden: options.format.render[kKeepHidden],
        toHtml: isHtmlCompatible(options.format),
        toLatex: isLatexOutput(options.format.pandoc),
        toMarkdown: isMarkdownOutput(options.format.pandoc),
        figFormat: options.format.execute[kFigFormat],
        figDpi: options.format.execute[kFigDpi],
      },
    );

    // return dependencies as either includes or raw dependencies
    const dependencies = executeResultDependencies(
      options.dependencies ? "includes" : "dependencies",
      result.dependencies,
    );

    // if it's a transient notebook then remove it
    // (unless keep-ipynb was specified)
    cleanupNotebook(options.target, options.format);

    // return results
    return {
      markdown: result.markdown,
      supporting: [join(assets.base_dir, assets.supporting_dir)],
      filters: [],
      dependencies,
      preserve: result.htmlPreserve,
      postProcess: result.htmlPreserve &&
        (Object.keys(result.htmlPreserve).length > 0),
    };
  },

  executeTargetSkipped: cleanupNotebook,

  devServerRenderOnChange: (input: string) => {
    return Promise.resolve(isJupyterNotebook(input));
  },

  dependencies: (options: DependenciesOptions) => {
    const includes: PandocIncludes = {};
    if (options.dependencies) {
      const includeFiles = includesForJupyterWidgetDependencies(
        options.dependencies as JupyterWidgetDependencies[],
      );
      if (includeFiles.inHeader) {
        includes[kIncludeInHeader] = includeFiles.inHeader;
      }
      if (includeFiles.afterBody) {
        includes[kIncludeAfterBody] = includeFiles.afterBody;
      }
    }
    return Promise.resolve({
      includes,
    });
  },

  postprocess: (options: PostProcessOptions) => {
    // read the output file
    let output = Deno.readTextFileSync(options.output);

    // substitute
    output = restorePreservedHtml(
      output,
      options.preserve,
    );

    // re-write the output
    Deno.writeTextFileSync(options.output, output);

    return Promise.resolve();
  },

  canFreeze: true,

  ignoreGlobs: () => {
    return ["**/venv/**", "**/env/**"];
  },

  keepFiles: (input: string) => {
    if (!isJupyterNotebook(input) && !input.endsWith(`.${kJupyterEngine}.md`)) {
      const [fileDir, fileStem] = dirAndStem(input);
      return [join(fileDir, fileStem + ".ipynb")];
    }
  },
};

function isQmdFile(file: string) {
  const ext = extname(file);
  return kQmdExtensions.includes(ext) || isMdFile(file);
}

function isMdFile(file: string) {
  const ext = extname(file);
  return kMdExtensions.includes(ext);
}

async function metadataFromInputFile(file: string) {
  if (isJupyterNotebook(file)) {
    return readYamlFromMarkdown(await markdownFromNotebook(file));
  } else {
    return readYamlFromMarkdown(Deno.readTextFileSync(file));
  }
}

async function createNotebookforTarget(target: ExecutionTarget) {
  const nb = await quartoMdToJupyter(target.source, true);
  Deno.writeTextFileSync(target.input, JSON.stringify(nb, null, 2));
}

function cleanupNotebook(target: ExecutionTarget, format: Format) {
  // remove transient notebook if appropriate
  const data = target.data as JupyterTargetData;
  if (data.transient) {
    if (!format.execute[kKeepIpynb]) {
      removeIfExists(target.input);
    }
  }
}

interface JupyterTargetData {
  transient: boolean;
}

function isHtmlCompatible(format: Format) {
  return isHtmlOutput(format.pandoc) ||
    (isMarkdownOutput(format.pandoc) && format.render[kPreferHtml]);
}

function executeResultDependencies(
  type: "includes" | "dependencies",
  dependencies?: JupyterWidgetDependencies,
) {
  // convert dependencies to include files
  const dependenciesAsIncludes = () => {
    const includes: PandocIncludes = {};
    if (dependencies) {
      const includeFiles = includesForJupyterWidgetDependencies(
        [dependencies],
      );
      if (includeFiles.inHeader) {
        includes[kIncludeInHeader] = includeFiles.inHeader;
      }
      if (includeFiles.afterBody) {
        includes[kIncludeAfterBody] = includeFiles.afterBody;
      }
    }
    return includes;
  };

  return {
    type,
    data: type === "includes"
      ? dependenciesAsIncludes()
      : dependencies
      ? [dependencies]
      : [],
  };
}

async function markdownFromNotebook(file: string) {
  const decoder = new TextDecoder("utf-8");
  const nbContents = await Deno.readFile(file);
  const nb = JSON.parse(decoder.decode(nbContents));
  const cells = nb.cells as Array<{ cell_type: string; source: string[] }>;
  const markdown = cells.reduce((md, cell) => {
    if (["markdown", "raw"].includes(cell.cell_type)) {
      return md + "\n" + cell.source.join("") + "\n";
    } else {
      return md;
    }
  }, "");
  return markdown;
}
