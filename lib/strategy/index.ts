/**
 * 策略层入口。
 *
 * 本目录零存储访问（spec §17 断言 3）：数据一律从 PointInTimeView 进来，
 * PIT 的具体实现在 lib/pit/。引擎也不 import 具体因子，只依赖 FactorRegistry 接口。
 */
export {
  DEFAULT_STRATEGY_YAML_REL, ACCOUNT_KEY_SUFFIX, normalizeAccountKey, StrategyConfigSchema,
  validateStrategyYaml, validateStrategyConfig, formatIssue, formatIssues,
} from "@/lib/strategy/schema";
export type {
  ValidationIssue, ValidateResult, ValidateOk, ValidateFail,
} from "@/lib/strategy/schema";

export {
  StrategyConfigError, defaultStrategyPath, parseStrategy, loadStrategyFile,
  createStrategyStore, writeParamInText, writeStrategyParam,
  accountRule, takeProfitRules, unparsedTakeProfit,
} from "@/lib/strategy/loader";
export type { LoadedStrategy, StrategyStore, ParamValue, TakeProfitRule } from "@/lib/strategy/loader";

export {
  createStrategyEngine, applyPortfolioCaps,
  LOW_CONFIDENCE, ATTACK_STRENGTH, KNOWN_GAP_KINDS,
} from "@/lib/strategy/engine";
export type { EngineDeps } from "@/lib/strategy/engine";

export {
  STRATEGY_SCHEMA_VERSION, PTSTRAT_EXT, exportStrategyPackage, importStrategyPackage,
  serializeStrategyPackage, parseStrategyPackage, packagePayloadSha256,
  writeStrategyPackage, readStrategyPackage,
} from "@/lib/strategy/package";
export type {
  StrategyPackage, PackageMeta, ExportInput, ImportOptions, ImportResult,
} from "@/lib/strategy/package";

export { indexYaml, locate } from "@/lib/strategy/yaml-pos";
export type { YamlIndex, YamlSpan } from "@/lib/strategy/yaml-pos";
