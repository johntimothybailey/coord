import fs from "node:fs/promises";
import fsSync, { constants } from "node:fs";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { enterWrapperCgroup, readLinuxProcessIdentity } from "../src/containment.js";
import type { CgroupLaunchReceipt } from "../src/containment.js";
import { writeWrapperEvidence } from "../src/launch-wrapper.js";
import type { WrapperSpec } from "../src/launch-wrapper.js";

/** Kernel+IPC transport simulation only. No real cgroup, PID migration, signal or qualification. */
export async function daemonKernelFixture(holdAfterKill = false) {
  const original = { open: fs.open, mkdir: fs.mkdir, statfs: fs.statfs, readlink: fs.readlink, readFile: fs.readFile, writeSync: fsSync.writeSync, spawn: childProcess.spawn };
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!, directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "coord-daemon-kernel-fixture-")));
  const mount = join(directory, "mount"), root = join(mount, "coord"), proc = join(directory, "proc");
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(proc);
  const seed = async (path: string) => { for (const [name, data] of Object.entries({ "cgroup.type": "domain\n", "cgroup.controllers": "cpu memory pids\n", "cgroup.events": "populated 0\nfrozen 0\n", "cgroup.procs": "", "cgroup.kill": "" })) await fs.writeFile(join(path, name), data); };
  await seed(root);
  const directoryFds = new Map<number, string>(), controlFds = new Map<number, string>();
  const events: string[] = [], boot = "11111111-1111-1111-1111-111111111111";
  const wrapperArgv: string[][] = [];
  let wrapperMembership = "/coord", actingWrapper = false, released: (() => void) | undefined;
  let crashWrapper: (() => Promise<void>) | undefined;
  const started = new Promise<void>(resolve => { released = resolve; });
  const procContents = (path: string): string => {
    if (path === "/proc/self/mountinfo") return `29 23 0:99 / ${mount} rw - cgroup2 cgroup rw\n`;
    if (path === "/proc/sys/kernel/random/boot_id") return boot + "\n";
    if (path === "/proc/self/cgroup") return `0::${actingWrapper ? wrapperMembership : "/coord"}\n`;
    if (path === `/proc/${process.pid}/cgroup`) return `0::${wrapperMembership}\n`;
    if (path === `/proc/${process.pid}/stat`) { const fields = Array.from({ length: 25 }, () => "0"); fields[0] = "S"; fields[2] = String(process.pid); fields[19] = "444"; return `${process.pid} (fixture) ${fields.join(" ")}\n`; }
    throw Object.assign(new Error("Unknown synthetic proc path"), { code: "ENOENT" });
  };
  const mapProc = async (path: string) => { const target = join(proc, Buffer.from(path).toString("hex")); await fs.writeFile(target, procContents(path)); return target; };
  const apply = (path: string, value: string) => {
    if (path.endsWith("cgroup.procs")) {
      if (value !== "0\n" || !actingWrapper) throw new Error("Fixture permits only wrapper self-attach");
      wrapperMembership = `/coord/${dirname(path).split("/").at(-1)}`;
      fsSync.writeFileSync(join(dirname(path), "cgroup.procs"), `${process.pid}\n`); fsSync.writeFileSync(join(dirname(path), "cgroup.events"), "populated 1\nfrozen 0\n"); events.push("self_attached");
    } else {
      if (value !== "1\n") throw new Error("Unexpected synthetic kill value");
      if (!holdAfterKill) { fsSync.writeFileSync(join(dirname(path), "cgroup.events"), "populated 0\nfrozen 0\n"); fsSync.writeFileSync(join(dirname(path), "cgroup.procs"), ""); events.push("kernel_tree_stopped"); }
      else events.push("kernel_stop_unconfirmed");
    }
  };
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  fs.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => { const result = await original.mkdir(...args); if (String(args[0]).startsWith(root + "/coord-")) await seed(String(args[0])); return result; }) as typeof fs.mkdir;
  fs.statfs = (async (...args: Parameters<typeof fs.statfs>) => ({ ...await original.statfs(...args), type: args[1]?.bigint ? 0x63677270n : 0x63677270 })) as typeof fs.statfs;
  fs.readlink = (async (...args: Parameters<typeof fs.readlink>) => args[0] === "/proc/self/ns/cgroup" ? "cgroup:[111111]" : original.readlink(...args)) as typeof fs.readlink;
  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => String(args[0]).startsWith("/proc/") ? procContents(String(args[0])) : original.readFile(...args)) as typeof fs.readFile;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    let path = String(args[0]); const pinned = path.match(/^\/proc\/self\/fd\/(\d+)\/(cgroup\.[a-z_]+)$/);
    if (pinned) { const dir = directoryFds.get(Number(pinned[1])); if (!dir) throw new Error("Unknown synthetic retained fd"); path = join(dir, pinned[2]!); }
    else if (path.startsWith("/proc/")) path = await mapProc(path);
    const file = await original.open(path, ...args.slice(1) as [Parameters<typeof fs.open>[1], Parameters<typeof fs.open>[2]]), info = await file.stat(), fd = file.fd, close = file.close.bind(file);
    if (info.isDirectory()) directoryFds.set(fd, path);
    if (typeof args[1] === "number" && (args[1] & constants.O_WRONLY) && /\/cgroup\.(procs|kill)$/.test(path)) { controlFds.set(fd, path); file.write = (async (data: Buffer, offset = 0, length = data.length) => { apply(path, data.subarray(offset, offset + length).toString()); return { bytesWritten: length, buffer: data }; }) as typeof file.write; }
    file.close = async () => { directoryFds.delete(fd); controlFds.delete(fd); await close(); }; return file;
  }) as typeof fs.open;
  fsSync.writeSync = ((...args: unknown[]) => { const path = controlFds.get(Number(args[0])); if (!path) return (original.writeSync as (...values: unknown[]) => number)(...args); const data = args[1] as Buffer, offset = Number(args[2] ?? 0), length = Number(args[3] ?? data.length); apply(path, data.subarray(offset, offset + length).toString()); return length; }) as typeof fsSync.writeSync;
  childProcess.spawn = ((binary: string, argv: string[], options: Parameters<typeof childProcess.spawn>[2]) => {
    if (!argv[0]?.endsWith("/launch-wrapper.js")) return original.spawn(binary, argv, options);
    events.push("wrapper_spawn_requested");
    const child = new EventEmitter() as EventEmitter & { pid: number; connected: boolean; send(value: unknown, callback: (error?: Error) => void): boolean };
    child.pid = process.pid; child.connected = true;
    let handle: Awaited<ReturnType<typeof enterWrapperCgroup>> | undefined;
    crashWrapper = async () => { await handle?.close(); handle = undefined; child.connected = false; events.push("wrapper_crashed"); child.emit("exit", 1); };
    child.send = (raw, callback) => { const message = raw as { type: string; spec?: WrapperSpec }; void (async () => {
      if (message.type === "start") {
        const spec = message.spec!; actingWrapper = true;
        wrapperArgv.push([...spec.argv]);
        let identity;
        try { identity = await readLinuxProcessIdentity(process.pid, spec.launchId); handle = await enterWrapperCgroup(spec.containment!, identity); } finally { actingWrapper = false; }
        const receipt: CgroupLaunchReceipt = { schemaVersion: 1, identity: spec.identity, launchId: spec.launchId, machineId: spec.machineId, workspace: spec.workspace, process: identity!, recordedAt: new Date().toISOString(), containment: spec.containment };
        await writeWrapperEvidence(spec.receiptDirectory, "wrapper-receipt.json", receipt, true); events.push("receipt_synced"); callback(); setImmediate(() => child.emit("message", { type: "receipt", receipt }));
      } else if (message.type === "authorize") { events.push("wrapper_released"); callback(); released?.(); }
      else if (message.type === "abort") { handle?.kill(); await handle?.close(); child.connected = false; callback(); setImmediate(() => child.emit("exit", 0)); }
      else callback();
    })().catch(error => callback(error as Error)); return true; };
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  return { root, events, wrapperArgv, started, crashWrapper: async () => { if (!crashWrapper) throw new Error("No synthetic wrapper exists"); await crashWrapper(); }, allowStop() { holdAfterKill = false; }, async restore() { fs.open = original.open; fs.mkdir = original.mkdir; fs.statfs = original.statfs; fs.readlink = original.readlink; fs.readFile = original.readFile; fsSync.writeSync = original.writeSync; childProcess.spawn = original.spawn; Object.defineProperty(process, "platform", platform); syncBuiltinESMExports(); await fs.rm(directory, { recursive: true, force: true }); } };
}
