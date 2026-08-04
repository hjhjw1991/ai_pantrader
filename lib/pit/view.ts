/**
 * 别名入口。
 *
 * 前端的模块探测（lib/ui/adapters/engines.ts）按 "lib/pit/view.ts" 这个路径判断
 * PIT 层是否就绪，而实现文件按任务书叫 sqlite-view.ts。为一个字符串改实现文件名
 * 不值得，为让另一个层的探测生效补一个再导出很便宜 —— 所以留这一层。
 */
export * from "@/lib/pit/index";
