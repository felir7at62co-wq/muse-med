"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";
// 同 FeishuBindBanner：token 的实际 key 是 "drama_access_token"，
// 必须走 getToken()，不能自己拼字符串。
import { getToken } from "../../lib/auth";

/** 飞书官方二维码 SDK 注入的全局对象 */
declare global {
  interface Window {
    QRLogin?: (opts: {
      id: string;
      goto: string;
      width?: string;
      height?: string;
      style?: string;
    }) => { matchOrigin: (o: string) => boolean; matchData: (d: unknown) => boolean };
  }
}

const SDK_SRC =
  "https://lf-package-cn.feishucdn.com/obj/feishu-static/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.3.js";

type Result =
  | { ok: true; action: "login" | "auto_register"; access_token: string; refresh_token: string; message?: string }
  | { ok: false; error: string };

/**
 * 内嵌飞书扫码登录。
 *
 * 流程(飞书官方 QR SDK):
 *   1. 加载 SDK → window.QRLogin
 *   2. 用后端给的 authorize_url 作 goto, SDK 在容器里插一个 iframe 渲染二维码
 *   3. 用户扫码确认 → iframe 通过 postMessage 回传 tmp_code
 *   4. 把 tmp_code 拼到 goto 上跳转 → 飞书带 code 重定向回我们的 callback
 *
 * ⚠️ SDK 要求页面在 https 或 localhost 下, 否则扫码后 postMessage 收不到。
 *    生产已配 https://app.jubianai.net。
 */
export function FeishuQRLogin({
  mode = "login",
  onDone,
  className = "",
}: {
  /** login: 扫码登录/自动建号; link: 已登录用户绑定旧账号 */
  mode?: "login" | "link";
  onDone?: (r: Result) => void;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState("");
  // onDone 每次父组件渲染都是新函数引用，直接放进 effect 依赖会导致
  // 二维码反复重建（旧码失效、请求被 ERR_ABORTED）。用 ref 固定住。
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  // 存授权 URL 供「跳转授权」按钮用（与二维码同一个 goto，共用一次性 state）
  const gotoRef = useRef<string>("");

  // 注：绑定请求已移到落地页 app/auth/feishu/done。
  // 原因见下方 mode === "link" 分支的注释 —— 绑定必须走整页跳转，
  // 组件在跳转后就卸载了，回调只能由落地页处理。

  useEffect(() => {
    let cancelled = false;
    let onMessage: ((e: MessageEvent) => void) | null = null;

    (async () => {
      try {
        // 1) 取授权 URL(后端签发 state 防 CSRF)。
        //    purpose=link 时后端会在回调里只回传 code, 不做建号/换登录态。
        const r = await fetch(
          `/v1/auth/feishu/login-url?purpose=${mode === "link" ? "link" : "auto_login"}`,
          { cache: "no-store" },
        );
        if (!r.ok) throw new Error(`取授权地址失败(${r.status})`);
        const { authorize_url } = (await r.json()) as { authorize_url: string };
        if (cancelled) return;
        gotoRef.current = authorize_url;  // 存给按钮用

        // 2) 加载 SDK(只加载一次)
        if (!window.QRLogin) {
          await new Promise<void>((resolve, reject) => {
            const s = document.createElement("script");
            s.src = SDK_SRC;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error("飞书二维码组件加载失败(检查网络)"));
            document.head.appendChild(s);
          });
        }
        if (cancelled || !window.QRLogin) return;

        // 3) 渲染二维码。
        //    SDK 会往容器里插 iframe，而这个容器同时也被 React 管理 ——
        //    直接 innerHTML="" 清空会让 React 后续 unmount 时找不到自己的子节点，
        //    报 "removeChild: The node to be removed is not a child of this node"。
        //    所以容器交给 SDK 独占：React 侧永远只渲染一个空 div（无子元素），
        //    清理时逐个移除 SDK 插入的节点，不碰 React 的。
        const box = boxRef.current;
        if (!box) return;
        while (box.firstChild) box.removeChild(box.firstChild);

        const qr = window.QRLogin({
          id: box.id,
          goto: authorize_url,
          width: "260",
          height: "260",
          style: "width:260px;height:260px;border:none",
        });
        setPhase("ready");

        // 4) 监听扫码结果
        onMessage = (e: MessageEvent) => {
          // 必须双重校验来源与数据格式, 否则任意页面都能伪造消息
          if (!qr.matchOrigin(e.origin) || !qr.matchData(e.data)) return;
          const tmp = (e.data as { tmp_code?: string })?.tmp_code;
          if (!tmp) return;
          const sep = authorize_url.includes("?") ? "&" : "?";
          const next = `${authorize_url}${sep}tmp_code=${encodeURIComponent(tmp)}`;

          if (mode === "link") {
            // 绑定模式。
            //
            // 曾经的错误做法: 用隐藏 iframe 加载跳转链接, 想从
            // ifr.contentWindow.location 里读 code —— 行不通:
            //   ① iframe 跳到飞书域后跨域, 读 location 直接抛 SecurityError
            //   ② 最终回到我们域时 302 已被消费, load 事件时序也不可靠
            // 实测表现: 扫码打勾了, 但 /feishu/link 一次都没被调用。
            //
            // 现在的做法: 打一个 sessionStorage 标记后整页跳转。
            // 回调落地页读到标记就知道"这是绑定, 不是登录",
            // 于是拿 code 去调 /feishu/link, 而不是替换当前登录态。
            sessionStorage.setItem("fs_link_intent", "1");
            window.location.href = next;
          } else {
            // 登录模式: 直接整页跳转, 后端 callback 会签发 token
            window.location.href = next;
          }
        };
        window.addEventListener("message", onMessage, false);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setPhase("error");
        onDoneRef.current?.({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();

    return () => {
      cancelled = true;
      // SPA 里不摘监听会随每次挂载累积
      if (onMessage) window.removeEventListener("message", onMessage, false);
      // 卸载时清掉 SDK 插入的 iframe：这些节点不是 React 创建的，
      // 留着会在下次挂载时叠加，也会干扰 React 的 DOM diff。
      const box = boxRef.current;
      if (box) while (box.firstChild) box.removeChild(box.firstChild);
    };
    // 只依赖 mode：onDone 走 ref，避免父组件重渲染导致二维码重建
  }, [mode]);

  return (
    <div className={`flex flex-col items-center ${className}`}>
      {/* 外层负责尺寸与背景；loading 指示器放这里（React 管） */}
      <div className="relative w-[260px] h-[260px] rounded-lg overflow-hidden bg-white">
        {phase === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-ink-muted" />
          </div>
        )}
        {/* 这个 div 交给飞书 SDK 独占：React 不在里面渲染任何子节点，
            否则 SDK 插 iframe 后 React 卸载时会 removeChild 报错。 */}
        <div
          id={mode === "link" ? "fs_qr_link" : "fs_qr_login"}
          ref={boxRef}
          className="absolute inset-0"
        />
      </div>

      {phase === "error" && (
        <div className="mt-3 w-[260px] p-3 bg-danger/10 border border-danger/40 rounded-lg text-xs text-danger flex gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
          <span>{err}</span>
        </div>
      )}

      {phase === "ready" && (
        <>
          <p className="mt-3 text-sm text-ink-secondary">请用飞书扫码</p>
          {/* 授权登录入口：与扫码并存。
              在飞书客户端内打开本页时是免登的，点一下直接跳转最快；
              PC 浏览器则落到飞书登录页。
              绑定模式不给这个入口 —— 整页跳转会丢掉当前登录态，
              变成"用飞书号登录"，而不是把飞书绑到当前账号上。 */}
          {mode !== "link" && (
            <button
              type="button"
              onClick={() => { if (gotoRef.current) window.location.href = gotoRef.current; }}
              className="mt-3 text-sm text-primary hover:underline"
            >
              或点此跳转飞书授权登录
            </button>
          )}
        </>
      )}
    </div>
  );
}
