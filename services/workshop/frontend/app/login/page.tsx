"use client";
import React, { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { login } from "../../lib/auth";
import { homePathAfterLogin } from "@/components/VersionSwitcher";
import { Loader2, LogIn, ChevronDown } from "lucide-react";
import { AuthHero } from "@/components/auth/AuthHero";
import { FeishuQRLogin } from "@/components/auth/FeishuQRLogin";

// 外层用 Suspense 包裹 useSearchParams, 否则生产构建(next build)会因
// "useSearchParams() should be wrapped in a suspense boundary" 预渲染失败。
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-surface-base" />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // 默认落点 = **新版主页**（用户需求 2026-09-20："把新版的主页设为用户登录后的主页"）。
  // 只有显式带了 `?from=` 才尊重它（那是"你要去哪被拦下来了"的场景，
  // 例如从 /video-delivery 被踢来登录，登完要回去）。
  //
  // ⚠️ 这里**不再**按 localStorage 里的版本分发。原因：
  // 那条逻辑会让一个历史遗留的 `drama_ui_version=v1` 永久劫持登录落点 ——
  // 用户切过新版、登出再登入又被扔回旧主页，看起来就是"切换没生效"。
  // 版本选择仍可用（右上角切换器），但它不该决定**登录那一刻**去哪。
  const fromParam = searchParams.get("from");
  const [from, setFrom] = React.useState(homePathAfterLogin());
  React.useEffect(() => {
    if (fromParam) { setFrom(fromParam); return; }
    setFrom(homePathAfterLogin());
  }, [fromParam]);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 密码登录改为次要入口: 飞书扫码是主路径, 存量用户才需要密码登录一次去绑定
  const [showPwd, setShowPwd] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) {
      setError("用户名和密码不能为空");
      return;
    }
    setLoading(true);
    setError("");
    const result = await login(username, password);
    setLoading(false);
    if (result.ok) {
      router.push(from);
    } else {
      setError(result.error || "登录失败");
    }
  }

  return (
    <div className="min-h-screen bg-surface-base flex">
      {/* 左:品牌区 (桌面端展示) */}
      <AuthHero className="lg:w-1/2" />

      {/* 右:表单区 */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12">
        <div className="w-full max-w-md">
          {/* 移动端 Logo */}
          <div className="lg:hidden text-center mb-8">
            <h1 className="text-2xl font-bold bg-gradient-to-r from-primary to-cyan bg-clip-text text-transparent">
              🎬 剧本工坊
            </h1>
            <p className="text-ink-secondary text-sm mt-1">一句话生成长剧本</p>
          </div>

          <div className="mb-6">
            <h2 className="text-2xl font-bold text-ink-primary mb-1">欢迎回来</h2>
            <p className="text-sm text-ink-secondary">用飞书扫码登录，无需密码</p>
          </div>

          {/* 主路径: 飞书扫码。新员工扫完自动开号, 老员工扫完进已绑定的账号 */}
          <FeishuQRLogin />

          {/* 次要入口: 密码登录。
              保留它只为一件事 —— 存量用户登录后去「设置」里绑定飞书。
              绑定完成后就不再需要密码, 所以默认折叠、不做视觉强调。 */}
          <div className="mt-8 pt-6 border-t border-line">
            <button
              type="button"
              onClick={() => setShowPwd((v) => !v)}
              className="w-full flex items-center justify-center gap-1.5 text-sm text-ink-secondary hover:text-ink-primary transition-colors"
            >
              <span>已有账号？用密码登录后绑定飞书</span>
              <ChevronDown className={`w-4 h-4 transition-transform ${showPwd ? "rotate-180" : ""}`} />
            </button>

            {showPwd && (
              <form onSubmit={handleSubmit} className="space-y-4 mt-5">
                <div>
                  <label className="block text-sm font-medium mb-1.5 text-ink-primary">用户名</label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="请输入用户名"
                    autoFocus
                    className="w-full h-11 px-3 bg-surface-elevated border border-line focus:border-primary rounded-lg outline-none text-ink-primary placeholder:text-ink-muted transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1.5 text-ink-primary">密码</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="请输入密码"
                    className="w-full h-11 px-3 bg-surface-elevated border border-line focus:border-primary rounded-lg outline-none text-ink-primary placeholder:text-ink-muted transition-colors"
                  />
                </div>

                {error && (
                  <div className="p-3 bg-danger/10 border border-danger/40 rounded-lg text-sm text-danger">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-11 flex items-center justify-center gap-2 bg-surface-elevated border border-line hover:border-primary disabled:opacity-50 rounded-lg font-medium text-ink-primary transition"
                >
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogIn className="w-5 h-5" />}
                  {loading ? "登录中..." : "密码登录"}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
