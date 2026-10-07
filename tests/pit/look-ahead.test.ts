/**
 * 未来函数回归测试。
 *
 * 为什么要有这个文件：asOf 是唯一挡住未来数据的东西，而它一旦失效，
 * 症状是**回测变漂亮且不报错** —— 既不影响单元测试，也不会让流水线失败。
 * 这类 bug 只能靠"故意改未来数据、看过去决策动不动"来抓。
 *
 * 这里用轻量夹具做到每次跑测试都验一遍，比定期对全量库做截断比对快几个量级。
 * 全量表级检测留在 scripts/ 里按需跑（重，且要拷 3.6GB 库）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { identifyMainlines } from "@/lib/factors/sectors";
import { makeTempDb, type TempDb } from "./helpers";

let t: TempDb;
beforeEach(() => { t = makeTempDb(); });
afterEach(() => { t.close(); });

const D = "2026-09-15";
const FUTURE = ["2026-09-16", "2026-09-21", "2026-10-20"];

/** 中性板块名：避开 SEMI / 军工 / 电网 / 资源 四条写死必查链，只测板块榜那一半 */
const SEC = ["水产养殖", "调味品", "家纺", "照明设备", "陶瓷"];
const ZT_CODE = ["600001", "600002", "600003"];

function seedSector(date: string, pcts: number[]) {
  const ins = t.db.prepare(
    `INSERT INTO sector_rank (date, ts, sector, pct, leader_code) VALUES (?, ?, ?, ?, ?)`
  );
  SEC.forEach((s, i) => ins.run(date, `${date} 15:00:00`, s, pcts[i] ?? 0, null));
}
function seedZt(date: string, codes: string[]) {
  const ins = t.db.prepare(
    `INSERT INTO zt_pool (date, code, name, lbc, seal_amt, open_times, first_seal_ts, last_seal_ts, sector, turnover)
     VALUES (?, ?, ?, 1, 1e7, 0, '09:25:00', '09:25:00', ?, 1.0)`
  );
  for (const c of codes) ins.run(date, c, `票${c}`, "水产养殖");
}
/**
 * 比对键必须带上 pct：若只比板块名，未来数据改了同一批板块的相对强弱也照样通过，
 * 测试就成了摆设（这一点是注入式验证试出来的 —— 见下文件的说明）。
 */
const mainlinesAt = (asOf: string) =>
  identifyMainlines(createSqliteView(t.db, `${asOf} 15:05:00`), D, {})
    .mainlines.map(m => `${m.source}|${m.name}|${m.limitUpCount}|${(m.pct ?? -999).toFixed(4)}`).sort();

describe("主线识别不看未来", () => {
  it("删掉未来日期的板块榜与涨停池，当天的识别结果一字不变", () => {
    seedSector(D, [5, 4, 3, 2, 1]);
    seedZt(D, ZT_CODE);
    for (const f of FUTURE) { seedSector(f, [99, 98, 97, 96, 95]); seedZt(f, ZT_CODE); }
    const before = mainlinesAt(D);

    for (const f of FUTURE) {
      t.db.prepare(`DELETE FROM sector_rank WHERE date = ?`).run(f);
      t.db.prepare(`DELETE FROM zt_pool WHERE date = ?`).run(f);
    }
    expect(mainlinesAt(D)).toEqual(before);
  });

  it("把未来数据改得再夸张也不影响过去：涨停家数翻几十倍", () => {
    seedSector(D, [5, 4, 3, 2, 1]);
    seedZt(D, ["600001"]);
    const before = mainlinesAt(D);

    // 未来那天让「陶瓷」出现海量涨停 —— 若它被卷进 D 日的判断，主线条数/家数必变
    seedSector(FUTURE[0], [1, 1, 1, 1, 99]);
    seedZt(FUTURE[0], Array.from({ length: 40 }, (_, i) => `9${String(i).padStart(5, "0")}`));
    expect(mainlinesAt(D)).toEqual(before);
  });

  it("asOf 之前的日子不受其后补录的影响（补录 = 事后写库的天）", () => {
    seedSector(D, [5, 4, 3, 2, 1]);
    seedZt(D, ZT_CODE);
    const before = mainlinesAt(D);

    // 模拟"日后补齐历史数据"：往更早的日子插行，也不该改变 D 日的结论
    seedSector("2026-09-01", [99, 99, 99, 99, 99]);
    seedZt("2026-09-01", ZT_CODE);
    expect(mainlinesAt(D)).toEqual(before);
  });
});
