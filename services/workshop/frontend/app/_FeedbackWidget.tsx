"use client";
// 悬浮"反馈"按钮 + 弹窗: 登录用户可把遇到的问题留言提交。
// 位置: 固定右下角, 悬在 AI 聊天按钮 (right:24/bottom:24, 56px) 正上方。
// 仅登录用户可见; 提交到 POST /v1/feedback (后端从 token 取 user_id/昵称)。
import { useEffect, useState } from "react";
import { getToken } from "../lib/auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const MAX = 2000;

/**
 * 问题反馈弹窗。
 * - 受控模式(传 controlledOpen/onClose): 只渲染弹窗, 不显示悬浮按钮。用于从用户头像下拉菜单打开。
 * - 非受控模式(不传): 保留自带的悬浮按钮(向后兼容其它调用处)。
 */
export default function FeedbackWidget({
  controlledOpen,
  onClose,
}: { controlledOpen?: boolean; onClose?: () => void } = {}) {
  const controlled = controlledOpen !== undefined;
  const [authed, setAuthed] = useState(false);
  const [openLocal, setOpenLocal] = useState(false);
  const open = controlled ? !!controlledOpen : openLocal;
  const setOpen = (v: boolean) => {
    if (controlled) { if (!v) onClose?.(); }
    else setOpenLocal(v);
  };
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setAuthed(!!getToken());
  }, []);

  if (!authed) return null;

  async function submit() {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    setErr(null);
    try {
      const token = getToken();
      const res = await fetch(`${BASE}/v1/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          content,
          page_url: typeof window !== "undefined" ? window.location.pathname : null,
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        setErr(`提交失败: HTTP ${res.status} ${t.slice(0, 120)}`);
        return;
      }
      setDone(true);
      setText("");
      setTimeout(() => {
        setDone(false);
        setOpen(false);
      }, 1500);
    } catch (e: any) {
      setErr(`提交失败: ${e?.message || e}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {/* 悬浮按钮仅非受控模式显示; 受控模式(从头像菜单打开)不显示悬浮按钮 */}
      {!controlled && (
        <button
          onClick={() => setOpen(true)}
          title="反馈问题"
          style={floatBtnStyle}
          aria-label="反馈问题"
        >
          💬
        </button>
      )}

      {open && (
        <div style={panelStyle}>
          <div style={headerStyle}>
            <span style={{ fontWeight: 600 }}>问题反馈</span>
            <button onClick={() => setOpen(false)} style={closeBtnStyle} aria-label="关闭">✕</button>
          </div>
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX))}
              placeholder="把你遇到的问题或建议写在这里，我们会尽快处理…"
              rows={6}
              disabled={sending || done}
              style={textareaStyle}
            />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, color: "#94a3b8" }}>{text.length}/{MAX}</span>
              <button
                onClick={submit}
                disabled={!text.trim() || sending || done}
                style={{
                  ...sendBtnStyle,
                  opacity: !text.trim() || sending || done ? 0.5 : 1,
                  cursor: !text.trim() || sending || done ? "not-allowed" : "pointer",
                }}
              >
                {done ? "✓ 已收到" : sending ? "提交中…" : "发送"}
              </button>
            </div>
            {err && <div style={{ fontSize: 12, color: "#ef4444" }}>{err}</div>}
            {done && <div style={{ fontSize: 12, color: "#22c55e" }}>谢谢反馈！我们已收到。</div>}
          </div>
        </div>
      )}
    </>
  );
}

const floatBtnStyle: React.CSSProperties = {
  position: "fixed",
  right: 24,
  bottom: 96,
  width: 56,
  height: 56,
  borderRadius: 28,
  background: "linear-gradient(135deg, #0ea5e9, #2563eb)",
  color: "white",
  border: "none",
  fontSize: 24,
  cursor: "pointer",
  boxShadow: "0 6px 20px rgba(37, 99, 235, 0.4)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const panelStyle: React.CSSProperties = {
  position: "fixed",
  right: 24,
  bottom: 96,
  width: 360,
  maxWidth: "calc(100vw - 48px)",
  background: "linear-gradient(180deg, rgba(20,21,30,0.95) 0%, rgba(15,16,24,0.97) 100%)",
  backdropFilter: "blur(16px) saturate(140%)",
  WebkitBackdropFilter: "blur(16px) saturate(140%)",
  color: "#f1f5f9",
  borderRadius: 16,
  boxShadow: "0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05) inset",
  zIndex: 1001,
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  background: "linear-gradient(135deg, rgba(14,165,233,0.25), rgba(37,99,235,0.2))",
};

const closeBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#cbd5e1",
  cursor: "pointer",
  fontSize: 16,
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  padding: 10,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  color: "#f1f5f9",
  fontSize: 14,
  resize: "vertical",
  outline: "none",
  fontFamily: "inherit",
};

const sendBtnStyle: React.CSSProperties = {
  padding: "8px 18px",
  background: "linear-gradient(135deg, #0ea5e9, #2563eb)",
  color: "white",
  border: "none",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
};