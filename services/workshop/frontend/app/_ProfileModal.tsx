"use client";
import { useState } from "react";
import { X, User as UserIcon, Save, KeyRound, CheckCircle, AlertCircle } from "lucide-react";
import { authFetch, getUser, setAuth } from "../lib/auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

/**
 * 个人资料弹窗:
 *   - 修改昵称 (display_name) - PATCH /v1/auth/me
 *   - 修改密码 - POST /v1/auth/change-password
 *   - 用户名/登录 ID 只读展示 (用户不可改)
 */
export function ProfileModal({ onClose }: { onClose: () => void }) {
  const u = getUser();
  const [displayName, setDisplayName] = useState(u?.display_name || "");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [passwordMsg, setPasswordMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!u) return null;

  async function saveProfile() {
    if (!displayName.trim()) {
      setProfileMsg({ ok: false, text: "昵称不能为空" });
      return;
    }
    setSavingProfile(true);
    setProfileMsg(null);
    try {
      const res = await authFetch(`${BASE}/v1/auth/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName.trim() }),
      });
      if (res.ok) {
        const updated = await res.json();
        // 同步本地缓存,使顶栏立刻显示新昵称
        const token =
          (typeof localStorage !== "undefined" && localStorage.getItem("drama_access_token")) || "";
        const refresh =
          (typeof localStorage !== "undefined" && localStorage.getItem("drama_refresh_token")) || "";
        setAuth(updated, token, refresh);
        setProfileMsg({ ok: true, text: "昵称已更新" });
      } else {
        const t = await res.text();
        setProfileMsg({ ok: false, text: `失败: ${t.slice(0, 200)}` });
      }
    } catch (e: any) {
      setProfileMsg({ ok: false, text: e?.message || "网络错误" });
    } finally {
      setSavingProfile(false);
    }
  }

  async function savePassword() {
    if (newPassword.length < 6) {
      setPasswordMsg({ ok: false, text: "新密码至少 6 位" });
      return;
    }
    if (newPassword !== newPassword2) {
      setPasswordMsg({ ok: false, text: "两次输入的新密码不一致" });
      return;
    }
    setSavingPassword(true);
    setPasswordMsg(null);
    try {
      const res = await authFetch(`${BASE}/v1/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
      });
      if (res.ok) {
        setPasswordMsg({ ok: true, text: "密码已修改" });
        setOldPassword("");
        setNewPassword("");
        setNewPassword2("");
      } else {
        const j = await res.json().catch(() => ({ detail: "失败" }));
        setPasswordMsg({ ok: false, text: j.detail || "失败" });
      }
    } catch (e: any) {
      setPasswordMsg({ ok: false, text: e?.message || "网络错误" });
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 overflow-y-auto"
      onClick={onClose}
    >
      <div className="min-h-full flex items-center justify-center p-4">
        <div
          className="bg-surface-overlay border border-primary/30 rounded-2xl w-full max-w-lg shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bg-surface-overlay border-b border-line px-5 py-3 flex items-center justify-between rounded-t-2xl">
            <h2 className="text-lg font-bold text-ink-primary flex items-center gap-2">
              <UserIcon className="w-5 h-5 text-primary" />
              个人资料
            </h2>
            <button onClick={onClose} className="p-1 hover:bg-surface-base rounded">
              <X className="w-5 h-5 text-ink-secondary" />
            </button>
          </div>

          <div className="p-5 space-y-5 text-ink-primary">
          {/* 只读账号信息 */}
          <div className="bg-surface-base/50 rounded p-3 text-sm space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-ink-secondary w-20">登录账号</span>
              <code className="flex-1 bg-surface-overlay px-2 py-0.5 rounded text-xs">
                {u.username}
              </code>
              <span className="text-xs text-ink-muted">不可修改</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-ink-secondary w-20">角色</span>
              <span className="text-xs px-2 py-0.5 bg-surface-overlay rounded">{u.role}</span>
            </div>
          </div>

          {/* 昵称 */}
          <section>
            <h3 className="text-sm font-semibold mb-2 text-primary">修改昵称</h3>
            <div className="space-y-2">
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="昵称(其他人看到的名字)"
                maxLength={64}
                disabled={savingProfile}
                className="w-full px-3 py-2 bg-surface-base border border-line rounded text-sm focus:outline-none focus:border-primary"
              />
              <button
                onClick={saveProfile}
                disabled={
                  savingProfile ||
                  !displayName.trim() ||
                  displayName.trim() === (u.display_name || "").trim()
                }
                className="w-full px-4 py-2 rounded bg-primary hover:bg-primary/90 text-white disabled:opacity-50 text-sm font-semibold flex items-center justify-center gap-2 transition"
              >
                <Save className="w-4 h-4" />
                {savingProfile ? "保存中..." : "保存昵称"}
              </button>
              {profileMsg && (
                <div
                  className={`text-xs flex items-center gap-1.5 ${
                    profileMsg.ok ? "text-success" : "text-danger"
                  }`}
                >
                  {profileMsg.ok ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                  {profileMsg.text}
                </div>
              )}
            </div>
          </section>

          {/* 修改密码 */}
          <section className="pt-3 border-t border-line">
            <h3 className="text-sm font-semibold mb-2 text-primary flex items-center gap-1.5">
              <KeyRound className="w-4 h-4" />
              修改密码
            </h3>
            <div className="space-y-2">
              <input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder="当前密码"
                disabled={savingPassword}
                className="w-full px-3 py-2 bg-surface-base border border-line rounded text-sm focus:outline-none focus:border-primary"
              />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="新密码 (至少 6 位)"
                disabled={savingPassword}
                className="w-full px-3 py-2 bg-surface-base border border-line rounded text-sm focus:outline-none focus:border-primary"
              />
              <input
                type="password"
                value={newPassword2}
                onChange={(e) => setNewPassword2(e.target.value)}
                placeholder="再次输入新密码"
                disabled={savingPassword}
                className="w-full px-3 py-2 bg-surface-base border border-line rounded text-sm focus:outline-none focus:border-primary"
              />
              <button
                onClick={savePassword}
                disabled={savingPassword || !oldPassword || !newPassword || !newPassword2}
                className="w-full px-4 py-2 rounded bg-primary hover:bg-primary/90 text-white disabled:opacity-50 text-sm font-semibold flex items-center justify-center gap-2 transition"
              >
                <Save className="w-4 h-4" />
                {savingPassword ? "保存中..." : "修改密码"}
              </button>
              {passwordMsg && (
                <div
                  className={`text-xs flex items-center gap-1.5 ${
                    passwordMsg.ok ? "text-success" : "text-danger"
                  }`}
                >
                  {passwordMsg.ok ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                  {passwordMsg.text}
                </div>
              )}
            </div>
          </section>
        </div>

          <div className="bg-surface-overlay border-t border-line px-5 py-3 flex justify-end rounded-b-2xl">
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded bg-surface-base hover:bg-surface-overlay border border-line text-sm text-ink-primary transition"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
