## 改了什么，为什么

<!-- 说清「为什么改」。diff 已经说明了「改了什么」。 -->

## 自查

- [ ] `pnpm exec tsc --noEmit` 通过
- [ ] `pnpm test` 通过
- [ ] `pnpm build` 通过
- [ ] 行为有变化的地方加了测试
- [ ] 读过 [CONTRIBUTING](../blob/main/CONTRIBUTING.md)，没有踩到四条硬约束
      （因子/策略层纯度 · 回测可复现 · 不看未来 · 缺数据不静默）

<!-- 下面几条按需勾，不涉及就删掉 -->
- [ ] 加了 npm script → 两个 README 都写了
- [ ] 加了 `spec §N` 引用 → `docs/ARCHITECTURE.md` 收录了
- [ ] 改动会提高数据源请求频率 → 已说明退避策略
