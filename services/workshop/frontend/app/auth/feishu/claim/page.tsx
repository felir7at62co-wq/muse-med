"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertCircle, UserPlus, KeyRound, ArrowLeft } from "lucide-react";
import { setAuth } from "../../../../lib/auth";
import { FeishuQRLogin } from "../../../../components/auth/FeishuQRLogin";
import { homePathAfterLogin } from "../../../../components/VersionSwitcher";

/**
 * 飞书认领页 —— 陌生飞书身份的分叉口。
 *
 * 这个页面的存在本身就是修复：后端过去对任何陌生 union_id **无条件自动建号**，
 * 老用户顺手扫一下就会拿到一个空白新号，而 users.feishu_union_id 是 UNIQUE，
 * 这个空号从此永久占住他的飞书身份 —— 他回头用密码登旧号再想绑定只会拿到 409，
 * 而解绑接口是硬 403。整个死结的源头，就是那一次没问过用户。
 *
 * 所以现在多问这一句。union_id 留在服务端（前端只拿到一次性 claim_token），
 * 用户选完再落库，误点也不会产生任何垃圾数据。
 */
export default function FeishuClaimPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [fsName, setFsName] = useState("");
  const [phase, setPhase] = useState<"loading" | "pick" | "existing">("loading");
  // busy 与 phase 分开：提交中要保持在当前那一屏（把 "working" 塞进 phase
  // 会让"回到上一步"丢掉用户已经填的内容，也让 TS 无法在分支里收窄类型）
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    const frag = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const t = frag.get("claim_token") || "";
    const n = frag.get("feishu_name") || "";
    if (!t) { setErr("认领链接无效，请回到登录页重新扫码"); return; }
    setToken(t);
    setFsName(n);
    // 地址栏里的一次性凭证清掉，避免用户复制链接时连带发出去
    window.history.replaceState(null, "", "/auth/feishu/claim");
    (async () => {
      try {
        const r = await fetch(`/v1/auth/feishu/claim/info?claim_token=${encodeURIComponent(t)}`,
                              { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.detail || "认领链接已失效，请重新扫码");
        setFsName(j.feishu_name || n);
        setPhase("pick");
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  /** 成功拿到登录态后统一收尾 */
  async function finish(data: { access_token: string; refresh_token?: string; user: any }) {
    setAuth(data.user, data.access_token, data.refresh_token);
    router.replace(homePathAfterLogin());
  }

  async function createNew() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/v1/auth/feishu/claim/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim_token: token }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j?.detail === "string" ? j.detail : `创建失败(${r.status})`);
      await finish(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function linkExisting(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) { setErr("请输入原账号的用户名和密码"); return; }
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/v1/auth/feishu/claim/existing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim_token: token, username, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j?.detail === "string" ? j.detail : `关联失败(${r.status})`);
      await finish(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (err && phase === "loading") {
    // 认领链接失效只有一种解法：重扫。跟 done 页同理，二维码直接摆这儿，
    // 不要把人踢回登录首屏让他自己再找一遍入口。
    return (
      <Shell>
        <div className="flex flex-col items-center">
          <div className="w-full p-3 bg-amber-500/10 border border-amber-500/40 rounded-lg text-sm text-amber-800 dark:text-amber-200 flex gap-2 mb-5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
            <span>{err}</span>
          </div>
          <FeishuQRLogin />
          <button
            onClick={() => router.replace("/login")}
            className="mt-5 w-full h-10 rounded-lg bg-surface-elevated border border-line hover:border-primary text-sm text-ink-primary transition"
          >返回登录页</button>
        </div>
      </Shell>
    );
  }

  if (phase === "loading") {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-10">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="text-sm text-ink-secondary">正在校验飞书身份…</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h2 className="text-xl font-bold text-ink-primary mb-1">
        你好，{fsName || "飞书用户"}
      </h2>
      <p className="text-sm text-ink-secondary mb-6">
        这个飞书账号还没有关联本站账号。请选择接下来怎么做 —— 选错了不要紧，
        但选对能省掉后面合并账号的麻烦。
      </p>

      {err && <div className="mb-4"><ErrBox msg={err} /></div>}

      {phase !== "existing" ? (
        <div className="space-y-3">
          <button
            onClick={createNew}
            disabled={busy}
            className="w-full p-4 text-left rounded-lg bg-surface-elevated border border-line hover:border-primary disabled:opacity-50 transition"
          >
            <div className="flex items-center gap-2 font-medium text-ink-primary">
              {busy
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <UserPlus className="w-4 h-4 text-primary" />}
              我是新用户，创建账号
            </div>
            <div className="mt-1 text-xs text-ink-secondary">
              第一次用本站。之后扫码即可登录，无需密码。
            </div>
          </button>

          <button
            onClick={() => { setErr(""); setPhase("existing"); }}
            disabled={busy}
            className="w-full p-4 text-left rounded-lg bg-surface-elevated border border-line hover:border-primary disabled:opacity-50 transition"
          >
            <div className="flex items-center gap-2 font-medium text-ink-primary">
              <KeyRound className="w-4 h-4 text-primary" />
              我已经有账号（用账号密码登录过）
            </div>
            <div className="mt-1 text-xs text-ink-secondary">
              把飞书绑到原账号上，草稿等数据全部保留。
              <b className="text-amber-600 dark:text-amber-400">推荐老用户走这里</b> ——
              选错成"新用户"会多出一个空账号，后面还得再合并回来。
            </div>
          </button>
        </div>
      ) : (
        <form onSubmit={linkExisting} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5 text-ink-primary">原账号用户名</label>
            <input
              type="text" value={username} autoFocus
              onChange={(e) => setUsername(e.target.value)}
              placeholder="就是你以前用来登录的用户名"
              className="w-full h-11 px-3 bg-surface-elevated border border-line focus:border-primary rounded-lg outline-none text-ink-primary placeholder:text-ink-muted transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5 text-ink-primary">原账号密码</label>
            <input
              type="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              className="w-full h-11 px-3 bg-surface-elevated border border-line focus:border-primary rounded-lg outline-none text-ink-primary placeholder:text-ink-muted transition-colors"
            />
          </div>
          <p className="text-xs text-ink-muted">
            绑定后该账号将只支持飞书扫码登录，密码会被清除。
          </p>
          <button
            type="submit"
            disabled={busy}
            className="w-full h-11 flex items-center justify-center gap-2 bg-primary hover:opacity-90 disabled:opacity-50 rounded-lg font-medium text-white transition"
          >
            {busy && <Loader2 className="w-5 h-5 animate-spin" />}
            {busy ? "关联中…" : "关联并登录"}
          </button>
          <button
            type="button"
            onClick={() => { setErr(""); setPhase("pick"); }}
            className="w-full flex items-center justify-center gap-1.5 text-sm text-ink-secondary hover:text-ink-primary transition"
          >
            <ArrowLeft className="w-4 h-4" /> 返回上一步
          </button>
        </form>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base p-6">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

function ErrBox({ msg }: { msg: string }) {
  return (
    <div className="p-4 bg-danger/10 border border-danger/40 rounded-lg text-sm text-danger flex gap-2">
      <AlertCircle className="w-5 h-5 shrink-0 mt-px" />
      <span>{msg}</span>
    </div>
  );
}
