import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  splitRawArgumentString,
} from "../plugins/nano/scripts/lib/args.mjs";

test("parseArgs collects positionals and bare tokens", () => {
  const { options, positionals } = parseArgs(["build", "src", "-"]);
  assert.deepEqual(positionals, ["build", "src", "-"]);
  assert.deepEqual(options, {});
});

test("parseArgs reads boolean and value options, including inline and aliases", () => {
  const { options, positionals } = parseArgs(
    ["--verbose", "--name=kimi", "-f", "out.txt", "rest"],
    {
      booleanOptions: ["verbose"],
      valueOptions: ["name", "file"],
      aliasMap: { f: "file" },
    },
  );
  assert.equal(options.verbose, true);
  assert.equal(options.name, "kimi");
  assert.equal(options.file, "out.txt");
  assert.deepEqual(positionals, ["rest"]);
});

test("parseArgs treats --no-style as false and -- as passthrough", () => {
  const { options, positionals } = parseArgs(
    ["--style=false", "--", "--not-an-option"],
    { booleanOptions: ["style"] },
  );
  assert.equal(options.style, false);
  assert.deepEqual(positionals, ["--not-an-option"]);
});

test("parseArgs throws when a value option is missing its value", () => {
  assert.throws(
    () => parseArgs(["--name"], { valueOptions: ["name"] }),
    /Missing value for --name/,
  );
});

test("splitRawArgumentString respects quotes and escapes", () => {
  assert.deepEqual(
    splitRawArgumentString(`review "two words" 'single' plain`),
    ["review", "two words", "single", "plain"],
  );
  assert.deepEqual(splitRawArgumentString("a\\ b c"), ["a b", "c"]);
  assert.deepEqual(splitRawArgumentString("   "), []);
});
