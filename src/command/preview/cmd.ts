/*
* cmd.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { existsSync } from "fs/mod.ts";

import * as colors from "fmt/colors.ts";

import { Command } from "cliffy/command/mod.ts";

import { findOpenPort, kLocalhost } from "../../core/port.ts";
import { fixupPandocArgs, parseRenderFlags } from "../render/flags.ts";
import { preview } from "./preview.ts";
import {
  kRenderDefault,
  kRenderNone,
  serveProject,
} from "../../project/serve/serve.ts";
import { isRStudio } from "../../core/platform.ts";
import { createTempContext } from "../../core/temp.ts";

import {
  initState,
  setInitializer,
} from "../../core/lib/yaml-validation/state.ts";
import { initPrecompiledModules } from "../../core/lib/yaml-validation/deno-init-precompiled-modules.ts";

export const previewCommand = new Command()
  .name("preview")
  .stopEarly()
  .option(
    "--port [port:number]",
    "Suggested port to listen on (defaults to random value between 3000 and 8000).\n" +
      "If the port is not available then a random port between 3000 and 8000 will be selected.",
  )
  .option(
    "--host [host:string]",
    "Hostname to bind to (defaults to 127.0.0.1)",
  )
  .option(
    "--render [format:string]",
    "Render to the specified format(s) before previewing",
    {
      default: kRenderNone,
    },
  )
  .option(
    "--no-render",
    "Do not re-render input files when they change.",
    {
      hidden: true,
    },
  )
  .option(
    "--presentation",
    "Preview in presentation mode",
    {
      hidden: true,
    },
  )
  .option(
    "--no-navigate",
    "Don't navigate the browser automatically.",
  )
  .option(
    "--no-browser",
    "Don't open a browser to preview the site.",
  )
  .option(
    "--no-browse",
    "Don't open a browser to preview the site.",
    {
      hidden: true,
    },
  )
  .option(
    "--watch-inputs",
    "Re-render input files when they change.",
  )
  .option(
    "--no-watch-inputs",
    "Do not re-render input files when they change.",
  )
  .option(
    "--shutdown-on-beacon",
    "Listen for a shutdown request from webpage preview.",
    {
      hidden: true,
    },
  )
  .arguments("[file:string] [...args:string]")
  .description(
    "Render and preview a Quarto document or website project. Automatically reloads the browser when\n" +
      "input files are re-rendered or document resources (e.g. CSS) change.\n\n" +
      "For website preview, the most recent execution results of computational documents are used to render\n" +
      "the site (this is to optimize startup time). If you want to perform a full render prior to\n" +
      'previewing pass the --render option with "all" or a comma-separated list of formats to render.\n\n' +
      "For document preview, input file changes will result in a re-render (pass --no-watch to prevent).\n\n" +
      "You can also include arbitrary command line arguments to be forwarded to " +
      colors.bold("quarto render") + ".",
  )
  .example(
    "Preview document",
    "quarto preview doc.qmd",
  )
  .example(
    "Preview document with render command line args",
    "quarto preview doc.qmd --toc",
  )
  .example(
    "Preview document (don't watch for input changes)",
    "quarto preview doc.qmd --no-watch-inputs",
  )
  .example(
    "Preview website with most recent execution results",
    "quarto preview",
  )
  .example(
    "Previewing website using a specific port",
    "quarto preview --port 4444",
  )
  .example(
    "Preview website (don't open a browser)",
    "quarto preview --no-browser",
  )
  .example(
    "Fully render all website/book formats then preview",
    "quarto preview --render all",
  )
  .example(
    "Fully render the html format then preview",
    "quarto preview --render html",
  )
  // deno-lint-ignore no-explicit-any
  .action(async (options: any, file: string, args: string[]) => {
    // one-time initialization of yaml validation modules
    setInitializer(initPrecompiledModules);
    await initState();

    file = file || Deno.cwd();
    if (!existsSync(file)) {
      throw new Error(`${file} not found`);
    }
    // provide default args
    args = args || [];

    // pull out our command line args
    const portPos = args.indexOf("--port");
    if (portPos !== -1) {
      options.port = parseInt(args[portPos + 1]);
      args.splice(portPos, 2);
    }
    const hostPos = args.indexOf("--host");
    if (hostPos !== -1) {
      options.host = parseInt(args[hostPos + 1]);
      args.splice(hostPos, 2);
    }
    const renderPos = args.indexOf("--render");
    if (renderPos !== -1) {
      options.render = String(args[renderPos + 1]);
      args.splice(renderPos, 2);
    }
    const presentationPos = args.indexOf("--presentation");
    if (presentationPos !== -1) {
      options.presentation = true;
      args.splice(presentationPos, 1);
    } else {
      options.presentation = false;
    }
    const noBrowsePos = args.indexOf("--no-browse");
    if (noBrowsePos !== -1) {
      options.browse = false;
      args.splice(noBrowsePos, 1);
    }
    const noBrowserPos = args.indexOf("--no-browser");
    if (noBrowserPos !== -1) {
      options.browser = false;
      args.splice(noBrowserPos, 1);
    }
    const noNavigatePos = args.indexOf("--no-navigate");
    if (noNavigatePos !== -1) {
      options.navigate = false;
      args.splice(noNavigatePos, 1);
    }
    const watchInputsPos = args.indexOf("--watch-inputs");
    if (watchInputsPos !== -1) {
      options.watchInputs = true;
      args.splice(watchInputsPos, 1);
    }
    const noWatchInputsPos = args.indexOf("--no-watch-inputs");
    if (noWatchInputsPos !== -1) {
      options.watchInputs = false;
      args.splice(noWatchInputsPos, 1);
    }
    // alias for --no-watch-inputs (used by older versions of quarto r package)
    const noWatchPos = args.indexOf("--no-watch");
    if (noWatchPos !== -1) {
      options.watchInputs = false;
      args.splice(noWatchPos, 1);
    }
    // alias for --no-watch-inputs (used by older versions of rstudio)
    const noRenderPos = args.indexOf("--no-render");
    if (noRenderPos !== -1) {
      options.watchInputs = false;
      args.splice(noRenderPos, 1);
    }

    const shutdownOnBeacon = args.indexOf("--shutdown-on-beacon");
    if (shutdownOnBeacon !== -1) {
      options.shutdownOnBeacon = true;
      args.splice(shutdownOnBeacon, 1);
    }

    // default watch-inputs if not specified
    if (options.watchInputs === undefined) {
      options.watchInputs = !isRStudio();
    }

    // default host if not specified
    options.host = options.host || kLocalhost;

    // select a port
    if (!options.port) {
      options.port = findOpenPort();
    } else {
      options.port = findOpenPort(parseInt(options.port));
    }

    // extract pandoc flag values we know/care about, then fixup args as
    // necessary (remove our flags that pandoc doesn't know about)
    const flags = parseRenderFlags(args);
    args = fixupPandocArgs(args, flags);

    // see if we are serving a project or a file
    if (Deno.statSync(file).isDirectory) {
      // project preview
      const tempContext = createTempContext();
      try {
        await serveProject(file, tempContext, flags, args, {
          port: options.port,
          host: options.host,
          render: options.render,
          browse: !!(options.browser && options.browse),
          watchInputs: options.watchInputs,
          navigate: options.navigate,
        });
      } finally {
        tempContext.cleanup();
      }
    } else {
      // single file preview
      if (
        options.render !== kRenderNone &&
        options.render !== kRenderDefault &&
        args.indexOf("--to") === -1
      ) {
        args.push("--to", options.render);
      }
      await preview(file, flags, args, {
        port: options.port,
        host: options.host,
        browse: !!(options.browser && options.browse),
        presentation: options.presentation,
        watchInputs: !!options.watchInputs,
        shutdownOnBeacon: !!options.shutdownOnBeacon,
      });
    }
  });
