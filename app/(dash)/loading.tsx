/**
 * 六个页签共用的切换骨架。
 *
 * 为什么必须有这个文件：App Router 在没有 loading 边界时，点了页签**什么都不做**，
 * 一直等服务端把整页渲染完才换屏。实测服务端渲染耗时（本机、暖库）：
 *   持仓/台账 ~25ms · 观察池 ~35ms · 作战台 350–2500ms · 回测/设置 20ms，但每 60 秒有一次 4.1s
 * 也就是说点一下页签，界面有可能整整卡死四秒，且没有任何反馈 ——
 * 用户分不清是慢、是点空了、还是挂了，于是又点一次，把事情变得更糟。
 *
 * 有了这个边界，切换立刻换屏，慢的部分变成"正在加载"而不是"没反应"。
 * 它挂在 (dash) 这一层而不是各页各一份：首屏 HTML 里就带着这份骨架
 * （flight 数据里能搜到 animate-pulse），客户端路由拿在手上，
 * 之后在六个子页之间怎么切都能立刻画出来，不必等任何 prefetch ——
 * 这点很关键，因为 dev 下 App Router 的 Link prefetch 是被硬关掉的
 * （next/dist/client/link.js:378，`process.env.NODE_ENV === "development"` 直接 return）。
 *
 * 骨架会一直挂到整页渲染完，不会边渲染边填：这几个页面的 DB 读取都是同步的，
 * 服务端在渲染结束前一个字节都不发（实测 TTFB == total）。
 * 想让它分段流下来，得把慢的部分拆成会挂起的 async 子组件。目前没这么做 ——
 * 最慢的作战台稳态 280ms，为它把页面拆散不划算。
 *
 * 骨架里**一个数字都不能有**：这是交易界面，占位的假数字会被当成行情读。
 * router.refresh()（实时条每分钟一次）不会触发这个 fallback，
 * 它在 transition 里保留现有画面，所以自动刷新不会每分钟闪一下骨架。
 */
function Bar({ w }: { w: string }) {
  return <div className={`h-3 rounded-sm bg-line ${w}`} />;
}

function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  const widths = ["w-4/5", "w-3/5", "w-2/3", "w-1/2", "w-3/4"];
  return (
    <section className="bg-panel border border-line rounded-sm">
      <header className="flex items-baseline gap-3 px-3 py-1.5 border-b border-line bg-panel-2">
        <div className="h-3 w-24 rounded-sm bg-line-2" />
        <div className="ml-auto h-3 w-16 rounded-sm bg-line" />
      </header>
      <div className="p-3 flex flex-col gap-2">
        {Array.from({ length: rows }, (_, i) => (
          <Bar key={i} w={widths[i % widths.length]} />
        ))}
      </div>
    </section>
  );
}

export default function Loading() {
  return (
    <div className="flex flex-col gap-3 animate-pulse" aria-busy="true" aria-live="polite">
      <span className="sr-only">正在加载</span>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <PanelSkeleton rows={3} />
        <PanelSkeleton rows={3} />
        <PanelSkeleton rows={3} />
      </div>
      <PanelSkeleton rows={5} />
      <PanelSkeleton rows={4} />
    </div>
  );
}
