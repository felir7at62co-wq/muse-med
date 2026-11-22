"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AlertTriangle, X, Loader2, GitMerge } from "lucide-react";
import { FeishuQRLogin } from "./FeishuQRLogin";
// 用 getToken 而不是自己拼 localStorage key：
// 实际存的是 "drama_access_token"，硬编码 "access_token" 会永远读不到，
// 表现为黄条不显示（已踩过）。
import { getToken, setAuth } from "../../lib/auth";

/**
 * 顶部提醒条。同一个组件承担两种互斥的提醒：
 *
 * ① `unbound` —— 有密码、没绑飞书的老账号 → 催绑定（不可关闭）。
 *    过渡期的目标是把存量用户全部迁到飞书登录，可关闭的提示条会被长期忽略，
 *    绑定率上不去，阶段三（关停密码登录）就永远无法启动。绑完自然消失。
 *
 * ② `legacy_hint` —— 当前登录的就是"扫码自动建出来的号"（login_id 以 fs_ 开头，
 *    后端在 /auth/me 里给出 `feishu_auto`）→ 提示"你以前是不是有个账号密码账号？"
 *    这是给存量受害者的**主入口**：他们此刻正坐在那个空白号里，
 *    自己往往不知道老账号还在，更不会想到去"绑定飞书"（他们明明已经绑了）。
 *    这条**可以关闭**（记在 localStorage，按用户 id 区分）：
 *    真正的新员工也是 fs_ 账号，对他们来说这是纯噪音，不给关就是骚扰。
 */
type State = "checking" | "off" | "unbound" | "legacy_hint";

const dismissKey = (uid: number | string) => `fs_legacy_hint_dismissed_${uid}`;

export function FeishuBindBanner() {
  const [state, setState] = useState<State>("checking");
  const [open, setOpen] = useState(false);
  const [uid, setUid] = useState<number | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    let dead = false;
    (async () => {
      // 登录页/回调页不显示：那时还没登录，或正在登录中
      if (pathname === "/login" || pathname?.startsWith("/auth/")) {
        setState("off"); return;
      }
      const token = getToken();
      if (!token) { setState("off"); return; }   // 未登录页面不显示
      try {
        const r = await fetch("/jubengongfang/v1/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!r.ok) { if (!dead) setState("off"); return; }
        const u = await r.json();
        if (dead) return;
        setUid(u?.id ?? null);
        if (!u?.feishu_bound) { setState("unbound"); return; }
        // 已绑定：只剩"你是不是自动建出来的号"这一种可能的提醒
        const dismissed = u?.id
          ? localStorage.getItem(dismissKey(u.id)) === "1"
          : false;
        setState(u?.feishu_auto && !dismissed ? "legacy_hint" : "off");
      } catch {
        if (!dead) setState("off");   // 接口异常时不打扰用户
      }
    })();
    return () => { dead = true; };
    // 依赖 pathname: 本组件挂在全局 layout 上, 登录是客户端路由跳转,
    // 组件不会重新挂载。不跟着路由变化重查, 登录后黄条永远不出现。
  }, [pathname]);

  function dismissLegacy() {
    if (uid != null) localStorage.setItem(dismissKey(uid), "1");
    setState("off");
  }

  if (state === "legacy_hint") {
    return (
      <>
        <div className="sticky top-0 z-50 w-full bg-sky-500/15 border-b border-sky-500/40 backdrop-blur">
          <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center gap-3 text-sm">
            <GitMerge className="w-4 h-4 shrink-0 text-sky-600 dark:text-sky-400" />
            <span className="flex-1 text-sky-900 dark:text-sky-200">
              这个账号是你第一次扫码时自动创建的。如果你以前还有一个用账号密码登录的号，
              可以把它合并过来，两边的草稿会并成一份。
            </span>
            <button
              onClick={() => setOpen(true)}
              className="shrink-0 px-3 py-1 rounded-md bg-sky-500 hover:bg-sky-600 text-white text-xs font-medium transition"
            >
              合并旧账号
            </button>
            <button
              onClick={dismissLegacy}
              className="shrink-0 p-1 rounded hover:bg-sky-500/20 text-sky-700 dark:text-sky-300"
              aria-label="我没有旧账号，不再提示"
              title="我没有旧账号，不再提示"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        {open && <ClaimLegacyModal onClose={() => setOpen(false)} />}
      </>
    );
  }

  if (state !== "unbound") return null;

  return (
    <>
      <div className="sticky top-0 z-50 w-full bg-amber-500/15 border-b border-amber-500/40 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center gap-3 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="flex-1 text-amber-900 dark:text-amber-200">
            你的账号还未绑定飞书。绑定后可直接扫码登录，且不影响现有草稿等数据。
          </span>
          <button
            onClick={() => setOpen(true)}
            className="shrink-0 px-3 py-1 rounded-md bg-amber-500 hover:bg-amber-600 text-white text-xs font-medium transition"
          >
            立即绑定
          </button>
        </div>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-surface-base rounded-xl p-6 w-full max-w-sm shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-semibold text-ink-primary">绑定飞书账号</h3>
              <button
                onClick={() => setOpen(false)}
                className="p-1 rounded hover:bg-surface-elevated text-ink-muted"
                aria-label="关闭"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-ink-secondary mb-5">
              扫码后，此飞书账号将与当前账号关联，历史数据保持不变。
            </p>
            <FeishuQRLogin mode="link" />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * 「合并旧账号」弹窗：输入原账号的用户名+密码，把当前这个 fs_ 自动号并回去。
 *
 * 鉴权是两个因素：当前登录态（证明你握着这个飞书身份）+ 老账号密码。
 * 后端 /feishu/claim-legacy 会返回**老账号**的新 token，这里直接换登录态。
 */
function ClaimLegacyModal({ onClose }: { onClose: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) { setErr("请输入原账号的用户名和密码"); return; }
    setBusy(true);
    setErr("");
    try {
      const token = getToken();
      if (!token) throw new Error("登录态已失效，请重新登录");
      const r = await fetch("/jubengongfang/v1/auth/feishu/claim-legacy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ username, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const d = j?.detail;
        throw new Error(typeof d === "string" ? d : `合并失败(${r.status})`);
      }
      // 合并后登录态要换成老账号的，否则页面还挂在已停用的 src 上
      setAuth(j.user, j.access_token, j.refresh_token);
      setDone(j.message || "合并完成");
      // 整页刷新，让所有列表按新账号重新拉一遍
      setTimeout(() => { window.location.href = "/jubengongfang/drafts"; }, 1200);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        className="bg-surface-base rounded-xl p-6 w-full max-w-sm shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-semibold text-ink-primary">合并我的旧账号</h3>
          <button
            onClick={onClose}
            disabled={busy}
            className="p-1 rounded hover:bg-surface-elevated text-ink-muted disabled:opacity-40"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {done ? (
          <div className="py-6 text-sm text-ink-primary">{done}</div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <p className="text-sm text-ink-secondary">
              输入你<b>以前用账号密码登录</b>的那个账号。当前账号的草稿会全部并过去，
              两边的数据都保留。
            </p>
            <div>
              <label className="block text-sm font-medium mb-1.5 text-ink-primary">旧账号用户名</label>
              <input
                type="text" value={username} autoFocus
                onChange={(e) => setUsername(e.target.value)}
                className="w-full h-11 px-3 bg-surface-elevated border border-line focus:border-primary rounded-lg outline-none text-ink-primary placeholder:text-ink-muted transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5 text-ink-primary">旧账号密码</label>
              <input
                type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full h-11 px-3 bg-surface-elevated border border-line focus:border-primary rounded-lg outline-none text-ink-primary placeholder:text-ink-muted transition-colors"
              />
            </div>
            {err && (
              <div className="p-3 bg-danger/10 border border-danger/40 rounded-lg text-sm text-danger">
                {err}
              </div>
            )}
            <p className="text-xs text-ink-muted">
              合并后请继续用飞书扫码登录（旧账号的密码会被清除）。
            </p>
            <button
              type="submit"
              disabled={busy}
              className="w-full h-11 flex items-center justify-center gap-2 bg-primary hover:opacity-90 disabled:opacity-50 rounded-lg font-medium text-white transition"
            >
              {busy && <Loader2 className="w-5 h-5 animate-spin" />}
              {busy ? "合并中…" : "确认合并"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
