/**
 * 工作台骨架屏 —— 三栏结构的占位版（PLAN-页面切换动画 §3.2/§3.3）
 *
 * ## 为什么要有它
 * 实测（2026-09-21，真实路径：草稿列表 → 点卡片）：从**点击**到 URL 变化
 * 有约 600 ms 完全静默 —— App Router 在新路由就绪前一直渲染**旧页面**，
 * 好了再整屏硬替换。用户感知就是"卡一下，啪地换了一张"，也就是那句
 * "转场非常生硬"。骨架屏把这段静默变成"立刻有版式"。
 *
 * ## 为什么必须是**同一个组件**给两处用
 * 这条链上有两个不同阶段：
 *   ① 路由段加载中 → `app/v2/drafts/[id]/loading.tsx`
 *   ② 页面已挂载、客户端还在取数 → 页面里的 `if (loading)`
 * 两处若各画各的（或一处骨架、一处菊花），用户会看到
 * **"骨架 → 转圈 → 内容"的三段跳**，比原来还乱。所以共用这一个。
 *
 * ## 布局必须与真实工作台同构
 * 顶栏 `h-14`、左栏 `w-60`、中右两栏 `flex-1` —— 全部照抄真实页面的类名，
 * 这样真内容替换进来时不会发生 layout shift（验收标准之一）。
 *
 * ## 刻意**不**给任务状态栏预留占位（2026-10-06）
 * 真实页面在 `</header>` 下面多了一条 `TaskStatusBar`。这里不给它留块，因为那条栏是
 * **条件渲染**的（没有任务在跑时组件自己 `return null`）：
 *   · 留了 → 常见情况（没任务）下真内容替换进来时整体**向上跳** ~28px，等于为了
 *     少见的情况牺牲常见情况；
 *   · 不留 → 只在"恰好有任务在跑时打开页面"这一种情况下跳一次，且跳的是
 *     一个明确表示"有活干"的状态条，用户不会觉得是排版坏了。
 * 所以这里的"不同构"是有意的，别当成遗漏补上。
 */
export function WorkbenchSkeleton() {
  return (
    <div className="h-screen overflow-hidden flex flex-col bg-surface-base" aria-busy="true">
      {/* 顶栏：与真实页面同为 h-14 + 同样的内边距与分隔线 */}
      <header className="h-14 flex items-center gap-3 px-3 border-b border-line flex-shrink-0">
        <Block className="w-7 h-7 rounded" />
        <Block className="w-7 h-7 rounded" />
        <Block className="w-40 h-4" />
        <Block className="w-16 h-3" />
        <div className="flex-1" />
        <Block className="w-20 h-6" />
        <Block className="w-20 h-6" />
        <Block className="w-16 h-6" />
        <Block className="w-7 h-7 rounded-full" />
      </header>

      <div className="flex-1 flex min-h-0">
        {/* 左：树图 */}
        <aside className="w-60 flex-shrink-0 border-r border-line py-2 px-2 space-y-2">
          <Block className="w-24 h-3" />
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-1.5 pl-3">
              <Block className="w-1.5 h-1.5 rounded-full" />
              <Block className="w-4 h-3" />
              <Block className={i % 3 === 0 ? 'w-24 h-3' : 'w-16 h-3'} />
            </div>
          ))}
        </aside>

        {/* 中：对话 */}
        <div className="flex-1 min-w-0 min-h-0 border-r border-line flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-line flex items-center gap-1.5">
            <Block className="w-16 h-6" />
            <Block className="w-16 h-6" />
            <Block className="w-16 h-6" />
          </div>
          <div className="flex-1 px-4 py-3 space-y-4">
            <Block className="w-4/5 h-3" />
            <Block className="w-3/5 h-3" />
            <Block className="w-[70%] h-3" />
          </div>
          {/* 输入框骨架：真实页面这里是一个 rounded-xl 的框 */}
          <div className="p-3 border-t border-line">
            <Block className="w-full h-16 rounded-xl" />
          </div>
        </div>

        {/* 右：文稿 */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          <div className="flex items-center gap-3 px-3 py-2 border-b border-line">
            {['w-10', 'w-10', 'w-10', 'w-10', 'w-10'].map((w, i) => (
              <Block key={i} className={`${w} h-4`} />
            ))}
          </div>
          <div className="px-4 py-3 space-y-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-2 pb-4 border-b border-line/40">
                <div className="flex items-center gap-2">
                  <Block className="w-16 h-3" />
                  <div className="flex-1" />
                  <Block className="w-12 h-3" />
                </div>
                <Block className="w-full h-3" />
                <Block className="w-[92%] h-3" />
                <Block className="w-[78%] h-3" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 草稿列表骨架（PLAN §3.2-b）。
 *
 * 网格列数照抄列表页的 `grid-cols-3 tablet:4 desktop:6 wide:8`，
 * 卡片高度按紧凑卡的实际高度给，避免真数据进来时整页跳动。
 */
export function DraftListSkeleton() {
  return (
    <div className="min-h-screen bg-surface-base" aria-busy="true">
      <div className="h-14 flex items-center gap-3 px-3 border-b border-line">
        <Block className="w-32 h-4" />
        <div className="flex-1" />
        <Block className="w-20 h-6" />
        <Block className="w-7 h-7 rounded-full" />
      </div>
      <main className="w-full px-3 pt-4">
        <div className="grid gap-2 grid-cols-3 tablet:grid-cols-4 desktop:grid-cols-6 wide:grid-cols-8">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Block className="w-full aspect-[3/4] rounded-lg" />
              <Block className="w-4/5 h-3" />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

/**
 * 一个占位块。
 *
 * 用 `animate-breathe`（透明度 0.6↔1）而不是 `animate-shimmer`：
 * shimmer 动的是 `background-position`，**必须配一条渐变背景**才看得出来，
 * 而渐变色得自己拼 —— 那就绕开了 tokens 体系、还得猜 CSS 变量名。
 * breathe 对纯色块直接生效，同样是 tailwind.config.ts 里早就有的动画，
 * 零新增配置、也不碰 token。
 */
function Block({ className = '' }: { className?: string }) {
  return <div className={`bg-surface-overlay rounded animate-breathe ${className}`} />;
}
