"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { homePathAfterLogin } from "@/components/VersionSwitcher";
import { register } from "../../lib/auth";
import { Loader2, UserPlus } from "lucide-react";
import { AuthHero } from "@/components/auth/AuthHero";

/**
 * 注册页 — 无需邮箱验证, 用户名 + 密码 + 确认密码 即可创建账号。
 * (邮箱验证链路不通, 已移除; 后端 /v1/auth/register 本就只需 username/password。)
 */
export default function RegisterPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [agreement, setAgreement] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (username.trim().length < 2) {
      setError("用户名至少 2 个字符");
      return;
    }
    if (password.length < 6) {
      setError("密码至少 6 位");
      return;
    }
    if (password !== confirmPwd) {
      setError("两次输入的密码不一致");
      return;
    }
    if (!agreement) {
      setError("请先勾选同意《服务协议》");
      return;
    }
    setLoading(true);
    const result = await register(username.trim(), password, displayName.trim() || username.trim());
    setLoading(false);
    if (result.ok) {
      // 注册成功同样落到**新版主页**（与登录一致，见 login/page.tsx 的说明）
      router.push(homePathAfterLogin());
    } else {
      setError(result.error || "注册失败");
    }
  }

  return (
    <div className="min-h-screen bg-surface-base flex">
      {/* 左:品牌区 */}
      <AuthHero className="lg:w-1/2" />

      {/* 右:表单区 */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12 overflow-y-auto">
        <div className="w-full max-w-md">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-ink-primary mb-1">注册新账号</h1>
            <p className="text-sm text-ink-secondary">填写用户名和密码即可创建账号</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-semibold mb-1 text-ink-primary">用户名 *</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="2-64 个字符, 用于登录"
                autoFocus
                autoComplete="username"
                className="w-full px-3 py-2 bg-surface-overlay border border-line focus:border-primary rounded-lg outline-none text-ink-primary placeholder:text-ink-muted"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold mb-1 text-ink-primary">昵称 <span className="text-xs text-ink-muted">(可选)</span></label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="不填则使用用户名"
                className="w-full px-3 py-2 bg-surface-overlay border border-line focus:border-primary rounded-lg outline-none text-ink-primary placeholder:text-ink-muted"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold mb-1 text-ink-primary">密码 *</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 6 位"
                autoComplete="new-password"
                className="w-full px-3 py-2 bg-surface-overlay border border-line focus:border-primary rounded-lg outline-none text-ink-primary placeholder:text-ink-muted"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold mb-1 text-ink-primary">确认密码 *</label>
              <input
                type="password"
                value={confirmPwd}
                onChange={(e) => setConfirmPwd(e.target.value)}
                placeholder="再次输入密码"
                autoComplete="new-password"
                className="w-full px-3 py-2 bg-surface-overlay border border-line focus:border-primary rounded-lg outline-none text-ink-primary placeholder:text-ink-muted"
              />
            </div>

            <label className="flex items-start gap-2 text-xs text-ink-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={agreement}
                onChange={(e) => setAgreement(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                我已阅读并同意
                <Link href="/legal/terms" target="_blank" className="text-primary hover:underline mx-1">《服务协议》</Link>
                与
                <Link href="/legal/privacy" target="_blank" className="text-primary hover:underline mx-1">《隐私政策》</Link>
              </span>
            </label>

            {error && (
              <div className="p-2 bg-danger/15 border border-danger/50 rounded text-sm text-danger">{error}</div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary/90 disabled:opacity-50 rounded-lg font-semibold transition text-white"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <UserPlus className="w-5 h-5" />}
              {loading ? "注册中..." : "注册并登录"}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-ink-secondary">
            已有账号? <Link href="/login" className="text-primary hover:underline">立即登录</Link>
          </div>
        </div>
      </div>
    </div>
  );
}