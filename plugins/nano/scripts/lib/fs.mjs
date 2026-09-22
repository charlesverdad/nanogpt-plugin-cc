import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "nano-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Writes `contents` to `filePath` without ever exposing a truncated or
 * partially-written file to a concurrent reader. A plain `writeFileSync`
 * truncates the target in place before writing it, so another process
 * (another companion invocation, a detached worker, ...) can observe an
 * empty or half-written file in between. Instead, write to a unique temp
 * file in the same directory and `renameSync` it over the target: on POSIX
 * (and on the single-volume case this project runs on) a rename is atomic,
 * so readers always see either the old file or the fully-written new one.
 */
export function atomicWriteFileSync(filePath, contents, encoding = "utf8") {
  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmpFile, contents, encoding);
    fs.renameSync(tmpFile, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup; the write failure is what matters
    }
    throw error;
  }
}

export function writeJsonFile(filePath, value) {
  atomicWriteFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

/**
 * Read all of stdin synchronously. `fs.readFileSync(0)` throws EAGAIN when
 * stdin is a non-blocking pipe whose writer has not finished (e.g. a large
 * prompt piped in by spawnSync), so read in a loop and wait briefly on EAGAIN.
 */
export function readStdinSync() {
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error?.code === "EAGAIN") {
        Atomics.wait(pause, 0, 0, 5);
        continue;
      }
      if (error?.code === "EOF") {
        break;
      }
      throw error;
    }
    if (bytesRead === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return readStdinSync();
}
