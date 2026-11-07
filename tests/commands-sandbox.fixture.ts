import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import childProcess from "node:child_process";
import nativeFs from "node:fs/promises";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";

/** Simulated Linux syscall/subprocess transport. It never executes repository argv outside a real sandbox. */
export function simulatedLinux(t: TestContext): { commands: string[][]; restore(): void } {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!, originalSpawn = childProcess.spawn;
  const originalRealpath = nativeFs.realpath, originalLstat = nativeFs.lstat, originalReadlink = nativeFs.readlink;
  const commands: string[][] = [];
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
  t.mock.method(nativeFs, "realpath", ((path: string) => path === "/usr/bin/bwrap" ? Promise.resolve(path) : originalRealpath(path)) as typeof nativeFs.realpath);
  t.mock.method(nativeFs, "lstat", ((path: string, options?: Parameters<typeof nativeFs.lstat>[1]) => path === "/usr/bin/bwrap" ? Promise.resolve({ isFile: () => true, mode: 0o100755, uid: 0 }) : originalLstat(path, options)) as typeof nativeFs.lstat);
  t.mock.method(nativeFs, "readlink", ((path: string) => path.startsWith("/proc/self/ns/") ? Promise.resolve(`synthetic-host:${path}`) : originalReadlink(path)) as typeof nativeFs.readlink);
  t.mock.method(childProcess, "spawn", ((binary: string, argv: string[], options: Parameters<typeof childProcess.spawn>[2]) => {
    if (binary === "/usr/bin/git") return originalSpawn(existsSync("/opt/homebrew/bin/git") ? "/opt/homebrew/bin/git" : "/usr/bin/git", argv, options);
    if (binary !== "/usr/bin/bwrap") return originalSpawn(binary, argv, options);
    commands.push([...argv]);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean; unref(): void };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { setImmediate(() => child.emit("close", null)); return true; }; child.unref = () => {};
    setImmediate(() => { if (argv.some(arg => arg.includes("COORD_SANDBOX_PROBE_V1"))) child.stdout.emit("data", Buffer.from("COORD_SANDBOX_PROBE_V1\n")); child.emit("close", 0); });
    return child;
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  let restored = false;
  const restore = (): void => { if (restored) return; restored = true; t.mock.restoreAll(); Object.defineProperty(process, "platform", originalPlatform); syncBuiltinESMExports(); };
  t.after(restore);
  return { commands, restore };
}
