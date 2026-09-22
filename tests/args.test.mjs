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

test("parseArgs collects multi-value options across occurrences mixing forms", () => {
  const { options, positionals } = parseArgs(
    ['--allow-bash', 'npm test', '--allow-bash=ls', 'rest'],
    { multiValueOptions: ['allow-bash'] },
  );
  assert.deepEqual(options['allow-bash'], ['npm test', 'ls']);
  assert.deepEqual(positionals, ['rest']);
});

test("parseArgs supports short aliases for multi-value options", () => {
  const { options } = parseArgs(
    ['-a', 'rm', '-a', 'ls'],
    { multiValueOptions: ['allow-bash'], aliasMap: { a: 'allow-bash' } },
  );
  assert.deepEqual(options['allow-bash'], ['rm', 'ls']);
});

test("parseArgs throws when a multi-value option is missing its value", () => {
  assert.throws(
    () => parseArgs(['--allow-bash'], { multiValueOptions: ['allow-bash'] }),
    /Missing value for --allow-bash/,
  );
});

test("parseArgs leaves an absent multi-value option undefined", () => {
  const { options } = parseArgs(['pos'], { multiValueOptions: ['allow-bash'] });
  assert.equal('allow-bash' in options, false);
  assert.equal(options['allow-bash'], undefined);
});

test("parseArgs interacts with splitRawArgumentString for multi-value options", () => {
  const tokens = splitRawArgumentString('--allow-bash "npm test" task text');
  const { options, positionals } = parseArgs(tokens, {
    multiValueOptions: ['allow-bash'],
  });
  assert.deepEqual(options['allow-bash'], ['npm test']);
  assert.deepEqual(positionals, ['task', 'text']);
});

test("splitRawArgumentString respects quotes and escapes", () => {
  assert.deepEqual(
    splitRawArgumentString(`review "two words" 'single' plain`),
    ["review", "two words", "single", "plain"],
  );
  assert.deepEqual(splitRawArgumentString("a\\ b c"), ["a b", "c"]);
  assert.deepEqual(splitRawArgumentString("   "), []);
});
