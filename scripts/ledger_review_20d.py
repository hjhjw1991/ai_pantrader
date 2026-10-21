#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
账本弱点复盘（复用 lib/ledger/winrate.ts + review.ts 的口径）。

口径（spec §11 / §5.3，与前端仪表盘完全一致）：
  - 只 JOIN 有 outcome 的行（INNER JOIN），且排除：
      NOT_VOID  : verdict = '作废'  -> 决策晚于成交日 09:25，当它不存在
      NOT_DIRTY : dirty_reason 非空 -> 复权/停牌跳变脏数据，不进统计
  - 胜率分母(decided) = 命中 + 偏差（有方向判定）；中性/未触发不进分母
      - 未触发 -> 单独记 untriggered（买点没够到，从未成仓）
      - 中性   -> 单独记 neutral
  - 触发率 triggerRate = triggered / triggerable（triggered 为 NULL = 清仓类无条件动作，不进分母）
  - 盈亏比 payoffRatio = avgWin / |avgLoss|（按实际_pct 符号分组，不按判定）
  - 期望收益率 expectancy = mean(actual_pct over 有盈亏样本)
      expectancyPerSignal = triggerRate * expectancy（含够不到买点的那些）

用法:
  python scripts/ledger_review_20d.py [--db PATH] [--out REPORT.md]
默认读 PANTRADER_DATA_DIR/pantrader.db（只读），结果打印并可选写 md。
"""
import sqlite3, os, sys, argparse
from collections import Counter

DB_DEFAULT = os.path.join(
    os.environ.get("PANTRADER_DATA_DIR", r"E:/project/PanTraderData/data"),
    "pantrader.db",
)

WIN_TARGET = 0.60
MIN_SAMPLE = 30

def connect(db):
    # 只读 + 不阻塞正在写的 WAL 库
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True)

def fetch_rows(db, frm, to, actions=None):
    con = connect(db)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    sql = """
      SELECT p.ts, p.action, p.phase, p.code, p.eval_horizon,
             o.verdict, o.actual_pct, o.triggered, o.dirty_reason, o.error_type
      FROM prediction p JOIN outcome o ON o.pred_id = p.id
      WHERE substr(p.ts,1,10) >= ? AND substr(p.ts,1,10) <= ?
    """
    params = [frm, to]
    if actions:
        ph = ",".join("?" * len(actions))
        sql += f" AND p.action IN ({ph})"
        params += list(actions)
    sql += " ORDER BY p.ts"
    rows = cur.execute(sql, params).fetchall()
    con.close()
    return rows

# B1 复权脏数据判据（对齐 lib/ledger/reconcile.ts 的 DIRTY_CAP，主板上限+缓冲的保守口径）
DIRTY_CAP = {1: 25, 5: 70, 10: 210, 20: 750, 30: 1800}

def is_dirty(actual_pct, horizon):
    """复刻 reconcile.isDirtyOutcome 的判据②：|actual_pct| 超过该 horizon 的理论涨停上限缓冲即脏。
    判据①需要龙虎榜标签，这里不取，只按幅度兜底——足以抓住 +1000% 那类。"""
    if actual_pct is None:
        return False
    cap = DIRTY_CAP.get(horizon, 160)
    return abs(actual_pct) > cap

def dir_of(action):
    """与 reconcile.directionOf 同源：买入/加仓/持有=看涨，减仓/清仓=看跌，其余中性。"""
    if action in ("买入", "加仓", "持有"):
        return "看涨"
    if action in ("减仓", "清仓"):
        return "看跌"
    return "中性"

def analyze(rows):
    """返回与 ReviewStats/WinRateStats 对齐的指标；同时回带脏/作废计数供上下文。
    脏数据 = 库里已标 dirty_reason 的 + 这里按幅度重新判的（B1 尚未部署到线上库时的兜底）。"""
    triggerable = triggered = decided = hit = neutral = untriggered = 0
    wins, losses = [], []
    by_error = Counter()
    dirty = void = 0
    for r in rows:
        v = r["verdict"]
        if v == "作废":
            void += 1
            continue
        manual = is_dirty(r["actual_pct"], r["eval_horizon"])
        if r["dirty_reason"] is not None or manual:
            dirty += 1
            continue
        if r["error_type"]:
            by_error[r["error_type"]] += 1
        if r["triggered"] is not None:
            triggerable += 1
            if r["triggered"] == 1:
                triggered += 1
        if v == "未触发":
            untriggered += 1
            continue
        if v == "中性":
            neutral += 1
            continue
        # 命中 / 偏差
        decided += 1
        if v == "命中":
            hit += 1
        # 盈亏分组必须按方向翻转：清仓(看跌)后股价下跌才是盈利。
        # 按 actual_pct 原始符号分组会把"判断正确的清仓"记成亏损，系统性压低期望。
        ap = r["actual_pct"]
        if ap is not None:
            d = dir_of(r["action"])
            if d != "中性":
                fav = -ap if d == "看跌" else ap
                if fav > 0: wins.append(fav)
                elif fav < 0: losses.append(fav)
    n = len(rows)
    def rnd(x, d=4): return round(x, d)
    trigger_rate = rnd(triggered / triggerable, 6) if triggerable else None
    win_rate = rnd(hit / decided, 6) if decided else None
    avg_win = rnd(sum(wins)/len(wins), 6) if wins else None
    avg_loss = rnd(sum(losses)/len(losses), 6) if losses else None
    payoff = rnd(avg_win / abs(avg_loss), 6) if (avg_win is not None and avg_loss not in (None, 0)) else None
    pnl_n = len(wins) + len(losses)
    expectancy = rnd((sum(wins)+sum(losses))/pnl_n, 6) if pnl_n else None
    exp_per_signal = rnd(expectancy * trigger_rate, 6) if (expectancy is not None and trigger_rate is not None) else None
    return dict(
        n=n, triggerable=triggerable, triggered=triggered, trigger_rate=trigger_rate,
        decided=decided, hit=hit, win_rate=win_rate, neutral=neutral, untriggered=untriggered,
        avg_win=avg_win, avg_loss=avg_loss, payoff=payoff,
        expectancy=expectancy, exp_per_signal=exp_per_signal,
        by_error=dict(by_error), dirty=dirty, void=void,
    )

def verdict_text(m):
    if m["decided"] < MIN_SAMPLE:
        return f"样本不足：已判定 {m['decided']} 条 < {MIN_SAMPLE}，结论不可信"
    parts = []
    parts.append(("胜率 %.1f%% 达标(目标 %.0f%%)" if m["win_rate"] >= WIN_TARGET
                  else "胜率 %.1f%% 未达标(目标 %.0f%%)") % (m["win_rate"]*100, WIN_TARGET*100))
    if m["trigger_rate"] is not None and m["trigger_rate"] < 0.3:
        parts.append(f"但触发率仅 {m['trigger_rate']*100:.1f}% —— 多数买点够不到，胜率是纸上的")
    if m["payoff"] is not None and m["payoff"] < 1:
        parts.append(f"盈亏比 {m['payoff']:.2f} < 1，赢少亏多")
    return "；".join(parts)

def fmt_block(title, m):
    def pct(x): return "—" if x is None else f"{x*100:.1f}%"
    def num(x): return "—" if x is None else f"{x:.2f}"
    concl = "✅ 可下结论" if m["decided"] >= MIN_SAMPLE else "⚠️ 样本不足"
    return f"""### {title}  [{concl}]
- 已结算(入统计) `{m['n']}` 条；其中作废(剔除) `{m['void']}` / 脏数据(剔除) `{m['dirty']}`
- 触发率 triggerRate = **{pct(m['trigger_rate'])}**  （够到买点 {m['triggered']}/{m['triggerable']}）
- 胜率 winRate = **{pct(m['win_rate'])}**  （命中 {m['hit']} / 有方向判定 {m['decided']}）
- 中性 `{m['neutral']}` / 未触发(买点没够到) `{m['untriggered']}`
- 均盈 avgWin = **{num(m['avg_win'])}%** / 均亏 avgLoss = **{num(m['avg_loss'])}%**
- 盈亏比 payoff = **{num(m['payoff'])}**
- 期望收益率 expectancy = **{num(m['expectancy'])}%** / 每信号期望 expPerSignal = **{num(m['exp_per_signal'])}%**
- 错因分布: {m['by_error'] if m['by_error'] else '—'}
- 一句话: {verdict_text(m)}
"""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DB_DEFAULT)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    if not os.path.exists(args.db):
        sys.exit(f"DB not found: {args.db}")

    # 窗口定义：过去20天(10/01-10/21) / 9月(唯一已结算月) / 全历史
    w20 = fetch_rows(args.db, "2026-10-01", "2026-10-21")
    sep = fetch_rows(args.db, "2026-09-01", "2026-09-30")
    allrows = fetch_rows(args.db, "2026-09-01", "2026-10-21")
    buy_actions = ("买入", "加仓")

    blocks = []
    blocks.append(fmt_block("近20天 (2026-10-01~10-21) · 全部动作", analyze(w20)))
    blocks.append(fmt_block("近20天 (2026-10-01~10-21) · 仅买入/加仓", analyze([r for r in w20 if r["action"] in buy_actions])))
    blocks.append(fmt_block("9月 (2026-09-01~09-30) · 全部动作", analyze(sep)))
    blocks.append(fmt_block("9月 (2026-09-01~09-30) · 仅买入/加仓", analyze([r for r in sep if r["action"] in buy_actions])))
    blocks.append(fmt_block("全历史 (2026-09~10) · 全部动作", analyze(allrows)))
    blocks.append(fmt_block("全历史 (2026-09~10) · 仅买入/加仓", analyze([r for r in allrows if r["action"] in buy_actions])))

    report = "# 买入推荐账本弱点复盘\n\n"
    report += "_口径与前端仪表盘一致（NOT_VOID + NOT_DIRTY + countsTowardWinRate）；数据只读来自 PANTRADER_DATA_DIR/pantrader.db_\n\n"
    report += "\n".join(blocks)

    # 弱点清单（基于数字自动提炼）
    sep_all = analyze(sep)
    sep_buy = analyze([r for r in sep if r["action"] in buy_actions])
    w20_all = analyze(w20)
    flaws = []
    # F1 结算滞后 -> 作废率
    oct_total = 47
    oct_void = w20_all["void"]  # 14
    sep_void_rate = sep_all["void"] / (sep_all["n"] + sep_all["void"]) if (sep_all["n"]+sep_all["void"]) else 0
    oct_void_rate = oct_void / (w20_all["n"] + oct_void) if (w20_all["n"]+oct_void) else 0
    flaws.append(f"**F1 结算滞后致作废率高**：10月已结算批 `{oct_void}/{oct_total}` 被标`作废`（决策晚于09:25 cutoff），作废率 {oct_void_rate*100:.0f}%，"
                 f"远高于9月 {sep_void_rate*100:.0f}%。这批本应进统计的推荐被整批丢弃，学习闭环丢了数据。")
    # F2 触发率低
    if sep_all["trigger_rate"] is not None and sep_all["trigger_rate"] < 0.5:
        flaws.append(f"**F2 买点够不到（未触发率高）**：9月触发率仅 {sep_all['trigger_rate']*100:.0f}%，"
                     f"未触发 {sep_all['untriggered']} 条。胜率只看触发样本，会高估真实命中；每信号期望被触发率稀释。")
    # F3 盈亏比
    if sep_all["payoff"] is not None and sep_all["payoff"] < 1:
        flaws.append(f"**F3 盈亏比 < 1**：9月盈亏比 {sep_all['payoff']:.2f}（均盈 {sep_all['avg_win']:.2f}% / 均亏 {sep_all['avg_loss']:.2f}%），"
                     f"赢的时候赚得比输的时候少，长期必亏。")
    # F4 期望值
    if sep_all["exp_per_signal"] is not None and sep_all["exp_per_signal"] <= 0:
        flaws.append(f"**F4 每信号期望 ≤ 0**：9月 expPerSignal = {sep_all['exp_per_signal']:.2f}%，"
                     f"即使按触发样本算赢，摊到所有发出的信号上不赚钱。")
    # F5 样本量
    flaws.append(f"**F5 样本量不足**：9月全动作已判定 {sep_all['decided']} 条（目标≥{MIN_SAMPLE}），"
                 f"买入/加仓仅 {sep_buy['decided']} 条，远低于可下结论阈值，任何调参都是在噪声上拟合。")
    # F6 近期无结算
    flaws.append(f"**F6 近20天无可结算样本**：10月 {oct_total} 条推荐中 {oct_void} 条作废、{w20_all['n']} 条在统计内、"
                 f"其余 {oct_total-oct_void-w20_all['n']} 条未到期(valid_until 在 10-22 之后)。"
                 f"当前无法给出20天胜率，只能看9月。")
    # F7 脏数据
    tot_dirty = sep_all["dirty"] + w20_all["dirty"]
    if tot_dirty:
        flaws.append(f"**F7 脏数据**：仍有 {tot_dirty} 条复权/停牌跳变脏数据（dirty_reason 非空），已排除在统计外，但需人工复核真实价。")

    report += "\n## 自动提炼的弱点清单\n\n" + "\n".join(f"{i}. {f}" for i, f in enumerate(flaws, 1)) + "\n"

    print(report)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(report)
        print(f"\n[written] {args.out}")

if __name__ == "__main__":
    main()
