import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfig } from "@/lib/config";
import { closeDaemonLog, daemonLogPath, openDaemonLog, resolveDataDir } from "@/lib/data/daemon-log";

/**
 * 守护进程输出落点。instrumentation.ts 不能 import lib/config（edge bundle），
 * daemon-log.ts 只好照抄一份数据目录的解析 —— 这里盯着两边别漂移。
 */
describe("daemon-log", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it("数据目录解析与 getConfig 一致", () => {
    for (const env of [
      { PANTRADER_DATA_DIR: "/x/data" },
      { HOME: "/home/a" },
      { HOME: "/home/a", USERPROFILE: "C:\\Users\\a" },
      {},
    ]) {
      expect(resolveDataDir(env)).toBe(getConfig(env).dataDir);
    }
  });

  it("追加写入 <dataDir>/logs/daemon.log，目录不存在时自动建", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-dlog-"));
    dirs.push(dir);
    const fd = openDaemonLog(dir);
    expect(typeof fd).toBe("number");
    fs.writeSync(fd as number, "第一行\n");
    closeDaemonLog(fd);
    const fd2 = openDaemonLog(dir);
    fs.writeSync(fd2 as number, "第二行\n");
    closeDaemonLog(fd2);
    expect(fs.readFileSync(daemonLogPath(dir), "utf8")).toBe("第一行\n第二行\n");
  });

  it("打不开就退回 ignore，不抛（日志丢了也得把进程拉起来）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-dlog-"));
    dirs.push(dir);
    const file = path.join(dir, "not-a-dir");
    fs.writeFileSync(file, "");
    expect(openDaemonLog(file)).toBe("ignore");
    expect(() => closeDaemonLog("ignore")).not.toThrow();
  });
});
