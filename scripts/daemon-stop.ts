/**
 * 停掉采集守护进程：pnpm daemon:stop（macOS / Windows 通用）。
 *
 * 守护进程是 detached 拉起的，网页服务退出后它还会继续按时刻表采集，要停就用这个。
 * 实现与安全核对见 lib/platform/stop.ts。
 */
import path from "node:path";
import { getConfig } from "@/lib/config";
import { stopDaemon } from "@/lib/platform/stop";

const r = await stopDaemon({ lockPath: path.join(getConfig().dataDir, "scheduler.pid") });
console.log(`[候潮] ${r.detail}`);
process.exitCode = r.status === "refused" || r.status === "failed" ? 1 : 0;
