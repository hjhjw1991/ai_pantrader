/**
 * PIT 层入口。
 *
 * 目录位置说明：spec §15 的目录树把 pit-view 画在 lib/strategy/ 下，
 * 但 spec §17 断言 3 要求 lib/strategy/ 里 grep 不到任何存储访问。
 * 断言进 CI，目录树只是示意，所以存储实现落在这里。
 */
export { createSqliteView, gapKinds, universeQuality } from "@/lib/pit/sqlite-view";
export type { UniverseQuality } from "@/lib/pit/sqlite-view";
