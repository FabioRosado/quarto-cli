/*
* errors.ts
*
* Copyright (C) 2021 by RStudio, PBC
*
*/

import { error } from "log/mod.ts";
import { mappedIndexToRowCol } from "../../core/lib/mapped-text.ts";
import { MappedString } from "../../core/lib/text-types.ts";
import { indexToRowCol } from "../../core/text.ts";

export function ojsParseError(
  // deno-lint-ignore no-explicit-any
  acornError: any, // we can't use SyntaxError here because acorn injects extra properties
  ojsSource: MappedString,
) {
  const acornMsg = String(acornError).split("\n")[0].trim().replace(
    / *\(\d+:\d+\)$/,
    "",
  );

  // console.log({
  //   ojsSource,
  //   pos: acornError.pos
  // });

  const { line, column } = mappedIndexToRowCol(ojsSource)(acornError.pos)!;
  /*const { index, originalString } = ojsSource.map(acornError.pos, true)!;
  const { line, column } = indexToRowCol(
    originalString.value,
  )(index);*/

  const errMsg = `OJS parsing failed on line ${line + 1}, column ${column + 1}`;
  error(errMsg);
  error(acornMsg);
  error("----- OJS Source:");
  const ojsSourceSplit = ojsSource.value.split("\n");
  for (let i = 0; i < ojsSourceSplit.length; ++i) {
    error(ojsSourceSplit[i]);
    if (i + 1 === acornError.loc.line) {
      error(" ".repeat(acornError.loc.column) + "^");
    }
  }
  error("-----");
}

// FIXME Figure out line numbering story for error reporting
export function jsParseError(
  jsSource: string,
  errorMessage: string,
) {
  error(
    "Parse error occurred while parsing the following statement in a Javascript code block.",
  );
  error(errorMessage);
  error("----- Source:");
  error(`\n${jsSource}`);
  error("-----");
}
