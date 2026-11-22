"use client";
import { useState } from "react";
import { X, Palette, Sun, Moon, Monitor, RefreshCw, Check } from "lucide-react";
import {
  ThemeConfig, DEFAULT_THEME, PRESET_COLORS,
  loadLocalTheme, saveTheme,
} from "../lib/theme";

/**
 * 主题设置 — 精简版 (需求2): 只保留 明/暗/跟随系统 + 几个固定主色预设。
 * 旧的取色器 / 背景图上传 / 模糊蒙版已下线 (见 docs/PLAN-script-view-theme-import.md)。
 */
export function ThemeSelector({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<ThemeConfig>(loadLocalTheme());

  function update(patch: Partial<ThemeConfig>) {
    const next = { ...cfg, ...patch };
    setCfg(next);
    saveTheme(next); // 立即保存 + 应用
  }

  function resetToDefault() {
    setCfg(DEFAULT_THEME);
    saveTheme(DEFAULT_THEME);
  }

  const modes: { v: NonNullable<ThemeConfig["mode"]>; icon: React.ReactNode; label: string }[] = [
    { v: "light", icon: <Sun className="w-4 h-4" />, label: "浅色" },
    { v: "dark", icon: <Moon className="w-4 h-4" />, label: "深色" },
    { v: "auto", icon: <Monitor className="w-4 h-4" />, label: "跟随系统" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm overflow-y-auto"
      onClick={onClose}
    >
      <div className="min-h-full flex items-center justify-center p-4">
        <div
          className="w-full max-w-md bg-surface-base border border-primary/30 rounded-2xl shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 头部 */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-line">
            <h2 className="text-lg font-bold flex items-center gap-2 text-ink-primary">
              <Palette className="w-5 h-5" />
              主题设置
            </h2>
            <button onClick={onClose} className="p-1 hover:bg-surface-overlay rounded text-ink-secondary">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-5 space-y-5">
            {/* 显示模式 */}
            <div>
              <h3 className="text-sm font-semibold mb-2 text-ink-primary">显示模式</h3>
              <div className="grid grid-cols-3 gap-2">
                {modes.map((m) => (
                  <button
                    key={m.v}
                    onClick={() => update({ mode: m.v })}
                    className={`flex items-center justify-center gap-1.5 p-3 rounded-lg border text-sm transition ${
                      cfg.mode === m.v
                        ? "border-primary bg-primary/15 text-ink-primary"
                        : "border-line hover:border-line-hover text-ink-secondary"
                    }`}
                  >
                    {m.icon}
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 主题色 */}
            <div>
              <h3 className="text-sm font-semibold mb-2 text-ink-primary">主题色</h3>
              <div className="grid grid-cols-5 gap-2">
                {PRESET_COLORS.map((p) => {
                  const active = (cfg.primary_color || "").toLowerCase() === p.primary.toLowerCase();
                  return (
                    <button
                      key={p.name}
                      title={p.name}
                      onClick={() => update({ primary_color: p.primary, accent_color: p.accent })}
                      className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition ${
                        active ? "border-primary bg-primary/10" : "border-line hover:border-line-hover"
                      }`}
                    >
                      <span
                        className="relative w-7 h-7 rounded-full flex items-center justify-center"
                        style={{ background: p.primary }}
                      >
                        {active && <Check className="w-4 h-4 text-white" />}
                      </span>
                      <span className="text-[11px] text-ink-secondary leading-tight text-center">{p.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end">
              <button
                onClick={resetToDefault}
                className="text-xs text-ink-secondary hover:text-ink-primary flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                恢复默认
              </button>
            </div>
          </div>

          {/* 底部 */}
          <div className="border-t border-line px-5 py-3 text-xs text-ink-muted text-center">
            💡 主题更改即时生效 · 跨设备自动同步
          </div>
        </div>
      </div>
    </div>
  );
}