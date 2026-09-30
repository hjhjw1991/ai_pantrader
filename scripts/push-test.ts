/**
 * 手机推送自检：给所有已配置的通道发一条测试消息，打印每条的结果。
 *
 * 用法：
 *   npx tsx scripts/push-test.ts
 *
 * 为什么要有这个脚本：
 *   推送配错（webhook 抄漏一位、代理没配）时的表现是"什么都没发生"——
 *   没有报错、没有日志，要等真信号来了才发现手机一直是静的。
 *   配好之后、以及每次改完推送配置，都先跑一下它。
 *
 * 失败才是信息：`ok:false` 会带上 errcode 或网络原因，照着改就行。
 */
import { loadCliEnv } from "@/lib/config";
import { shanghaiTs } from "@/lib/data/clock";
import { dispatchPush, isEnabled, readPushConfig } from "@/lib/ui/push";

loadCliEnv();

async function main(): Promise<void> {
  const cfg = readPushConfig();
  if (!isEnabled(cfg)) {
    console.log("[候潮] 未配置任何推送通道。");
    console.log("  在 .env.local 里至少填一项：");
    console.log("    PANTRADER_PUSH_WECOM   = 企业微信群机器人 webhook（多个用逗号分隔）");
    console.log("    PANTRADER_PUSH_BARK    = Bark key 或完整推送 URL");
    console.log("    PANTRADER_PUSH_URL     = 通用 webhook，POST JSON");
    process.exitCode = 1;
    return;
  }

  console.log(`[候潮] 已配置：企业微信 ${cfg.wecomUrls.length} 个 / Bark ${cfg.barkUrl ? 1 : 0} 个 /`
    + ` 通用 ${cfg.genericUrls.length} 个｜门槛 ${cfg.minSeverity}｜节流 ${cfg.throttleSec}s`
    + `｜代理 ${cfg.proxy ?? "（无）"}`);

  const results = await dispatchPush({
    kind: "push_selfcheck",
    severity: "warn",
    title: "候潮推送自检",
    body: `如果你在手机上看到这条，说明线路是通的。时间 ${shanghaiTs()}`,
    ts: shanghaiTs(),
  }, { config: cfg });

  if (results.length === 0) {
    console.log("[候潮] 一条都没发出去：检查级别门槛与节流配置");
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const r of results) {
    const tag = r.ok ? "✓" : "✗";
    console.log(`  ${tag} ${r.target}${r.status ? ` HTTP ${r.status}` : ""}${r.error ? ` ← ${r.error}` : ""}`);
    if (!r.ok) failed++;
  }
  console.log(failed === 0
    ? "[候潮] 全部通道送达。"
    : `[候潮] ${failed}/${results.length} 个通道失败。`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(e => {
  console.error("[候潮] 自检脚本异常:", e);
  process.exitCode = 1;
});
