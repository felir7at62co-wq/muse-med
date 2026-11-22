"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertCircle, GitMerge } from "lucide-react";
import { setAuth, getToken } from "../../../../lib/auth";
import { FeishuQRLogin } from "../../../../components/auth/FeishuQRLogin";
import { homePathAfterLogin } from "../../../../components/VersionSwitcher";

type Mergeable = {
  merge_token: string;
  holder: { id: number; username: string; feishu_name?: string | null };
  holder_data?: { drafts?: number };
  message?: string;
};

/**
 * 后端 `_fail()` 会把失败原因归类塞进 fragment 的 `error_code`。
 * 下面这几类的共同点是：**没出任何岔子，只是这一次授权作废了**
 * （刷新/后退把一次性凭证用掉了、二维码晾太久超时了、服务重启过）。
 * 用户唯一要做的事就是再扫一次码 —— 所以这一屏直接把二维码摆出来，
 * 而不是像过去那样只给一个「返回登录」把人踢回首屏、自己再找一遍入口。
 *
 * 生产上「state无效或已过期，请重新发起登录 / 返回登录」这条投诉就是这么来的：
 * 文案没说清发生了什么，按钮也没把人送到能解决问题的地方。
 */
const RESCAN_CODES = new Set(["used", "expired", "unknown", "state_invalid", "code_used"]);

/**
 * 飞书登录落地页。
 *
 * 后端 callback 检测到是浏览器跳转时，会 302 到这里，并把结果放在
 * URL fragment（`#access_token=...`）里。用 fragment 而不是 query 的原因：
 * `#` 后面的内容不会发给服务器，因此不进 access log、也不带进 Referer。
 *
 * 之前后端直接返回 JSON，浏览器把 token 原样糊在屏幕上（用户实测截图）。
 *
 * 绑定回流时还有第三种结局：飞书身份已经被一个"扫码自动建的空白号"占住
 * （改版前的存量受害者）。后端此时返回 409 + `detail.code === "mergeable"`
 * 和一个 merge_token，这里把对方账号的数据量摆给用户看，确认后一键合并。
 * ⚠️ 那个 detail 是 **对象** —— 老代码 `throw new Error(j.detail)` 会渲染成
 * `[object Object]`，用户只会看到一句天书。
 */
export default function FeishuDonePage() {
  const router = useRouter();
  const [err, setErr] = useState("");
  const [errCode, setErrCode] = useState("");
  const [mergeable, setMergeable] = useState<Mergeable | null>(null);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    const frag = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const error = frag.get("error");
    if (error) {
      setErrCode(frag.get("error_code") || "");
      setErr(error);
      // 地址栏里留着失效的 state/code 没有意义，还会让用户以为刷新能救回来
      window.history.replaceState(null, "", "/auth/feishu/done");
      return;
    }

    // 绑定回流：fragment 里是 link_code 而非 token。
    // 此时当前浏览器仍是旧账号的登录态，带上它去调 /feishu/link，
    // 把飞书身份挂到旧账号上（而不是换成飞书号登录）。
    const linkCode = frag.get("link_code");
    if (linkCode) {
      (async () => {
        try {
          const token = getToken();
          if (!token) throw new Error("登录态已失效，请重新登录后再绑定");
          const r = await fetch("/jubengongfang/v1/auth/feishu/link", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ link_code: linkCode }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            const d = j?.detail;
            if (d && typeof d === "object" && d.code === "mergeable") {
              window.history.replaceState(null, "", "/auth/feishu/done");
              setMergeable(d as Mergeable);
              return;
            }
            throw new Error(typeof d === "string" ? d : `绑定失败(${r.status})`);
          }
          window.history.replaceState(null, "", "/auth/feishu/done");
          sessionStorage.removeItem("fs_link_intent");
          router.replace(homePathAfterLogin());
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      })();
      return;
    }

    const at = frag.get("access_token");
    const rt = frag.get("refresh_token");
    if (!at) { setErr("未获取到登录凭证，请重新登录"); return; }

    (async () => {
      try {
        // fragment 里只有 token，用户信息再拉一次（顺带验证 token 有效）
        const r = await fetch("/jubengongfang/v1/auth/me", {
          headers: { Authorization: `Bearer ${at}` },
          cache: "no-store",
        });
        if (!r.ok) throw new Error(`凭证校验失败(${r.status})`);
        const user = await r.json();
        setAuth(user, at, rt || undefined);
        // 清掉地址栏里的 token，避免用户复制链接时把凭证一起发出去
        window.history.replaceState(null, "", "/auth/feishu/done");
        router.replace(homePathAfterLogin());
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [router]);

  async function doMerge() {
    if (!mergeable) return;
    setMerging(true);
    setErr("");
    try {
      const token = getToken();
      if (!token) throw new Error("登录态已失效，请重新登录后再试");
      const r = await fetch("/jubengongfang/v1/auth/feishu/merge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ merge_token: mergeable.merge_token }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const d = j?.detail;
        throw new Error(typeof d === "string" ? d : `合并失败(${r.status})`);
      }
      // 合并后当前账号的密码已被清空，后端也重新签发了 token，换上新的
      setAuth(j.user, j.access_token, j.refresh_token);
      sessionStorage.removeItem("fs_link_intent");
      router.replace(homePathAfterLogin());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setMerging(false);
    }
  }

  if (mergeable) {
    const drafts = mergeable.holder_data?.drafts ?? 0;
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-base p-6">
        <div className="w-full max-w-md">
          <div className="flex items-center gap-2 mb-3">
            <GitMerge className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold text-ink-primary">这个飞书身份已被占用</h2>
          </div>
          <p className="text-sm text-ink-secondary mb-4">
            {mergeable.message ||
              `这个飞书身份已经被账号「${mergeable.holder.username}」占用，多半是你之前顺手扫过一次码。`}
          </p>
          <div className="p-4 rounded-lg bg-surface-elevated border border-line text-sm text-ink-secondary space-y-1 mb-4">
            <div>占用账号：<b className="text-ink-primary">{mergeable.holder.username}</b>（ID {mergeable.holder.id}）</div>
            <div>它上面的草稿：<b className="text-ink-primary">{drafts}</b> 个</div>
            <div className="pt-1 text-xs text-ink-muted">
              合并后这些草稿会全部转到当前账号名下，一条不删；那个账号将停用。
              合并完成后本账号仅支持飞书扫码登录，密码会被清除。
            </div>
          </div>

          {err && (
            <div className="mb-4 p-3 bg-danger/10 border border-danger/40 rounded-lg text-sm text-danger flex gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
              <span>{err}</span>
            </div>
          )}

          <button
            onClick={doMerge}
            disabled={merging}
            className="w-full h-11 flex items-center justify-center gap-2 bg-primary hover:opacity-90 disabled:opacity-50 rounded-lg font-medium text-white transition"
          >
            {merging && <Loader2 className="w-5 h-5 animate-spin" />}
            {merging ? "合并中…" : "确认合并到当前账号"}
          </button>
          <button
            onClick={() => router.replace(homePathAfterLogin())}
            disabled={merging}
            className="mt-3 w-full h-10 rounded-lg bg-surface-elevated border border-line hover:border-primary disabled:opacity-50 text-sm text-ink-primary transition"
          >
            暂不合并
          </button>
        </div>
      </div>
    );
  }

  if (err) {
    // 「再扫一次就好」的那一类：把二维码直接摆在这一屏，就地重来。
    if (RESCAN_CODES.has(errCode)) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-surface-base p-6">
          <div className="max-w-sm w-full flex flex-col items-center">
            <div className="w-full p-3 bg-amber-500/10 border border-amber-500/40 rounded-lg text-sm text-amber-800 dark:text-amber-200 flex gap-2 mb-5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
              <span>{err}</span>
            </div>
            <FeishuQRLogin />
            <button
              onClick={() => router.replace("/login")}
              className="mt-5 w-full h-10 rounded-lg bg-surface-elevated border border-line hover:border-primary text-sm text-ink-primary transition"
            >
              返回登录页
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-base p-6">
        <div className="max-w-sm w-full">
          <div className="p-4 bg-danger/10 border border-danger/40 rounded-lg text-sm text-danger flex gap-2">
            <AlertCircle className="w-5 h-5 shrink-0 mt-px" />
            <span>{err}</span>
          </div>
          <button
            onClick={() => router.replace("/login")}
            className="mt-4 w-full h-10 rounded-lg bg-surface-elevated border border-line hover:border-primary text-sm text-ink-primary transition"
          >
            返回登录
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-surface-base">
      <Loader2 className="w-7 h-7 animate-spin text-primary" />
      <p className="text-sm text-ink-secondary">登录中…</p>
    </div>
  );
}
