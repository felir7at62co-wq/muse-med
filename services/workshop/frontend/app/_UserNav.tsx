"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  LogOut,
  Shield,
  Palette,
  UserCog,
  ChevronDown,
  Trash2,
  Brain,
  Sparkles,
  FileBarChart,
  Settings,
  MessageSquare,
} from "lucide-react";
import { getUser, logout, isAdmin, User } from "../lib/auth";
import { ThemeSelector } from "./_ThemeSelector";
import { ProfileModal } from "./_ProfileModal";
import { VersionSwitcher } from "../components/VersionSwitcher";
import FeedbackWidget from "./_FeedbackWidget";
import { initTheme } from "../lib/theme";

/**
 * UserNav — 分组下拉菜单 (PLAN §20 / 20 号设计图)
 *
 * 视觉:
 *   - 头像按钮 (Avatar 圆形 + 用户名 + 管理员徽标 + chevron)
 *   - 弹层分 3 组: 账户 / 工作区 / 管理 (无管理员时隐藏管理组)
 *   - 顶部带 "已登录身份" 卡 (头像 + 邮箱 + 角色)
 *   - 底部独立 "登出" 红色行
 *   - 玻璃态背景 (frosted-glass) + 边框 + 阴影
 *
 * 信息架构:
 *   账户:   个人资料 / 主题设置
 *   工作区: 回收站 / 记忆设置 / 对话工坊 / 速转工具
 *   管理:   管理后台 (admin only)
 */

type MenuItem = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description?: string;
  onClick?: () => void;
  href?: string;
  danger?: boolean;
};

type MenuGroup = {
  title: string;
  items: MenuItem[];
};

export function UserNav() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [open, setOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // 下拉弹层位置 (相对视口, fixed 定位) — 通过 Portal 渲染到 body, 避免被页面卡片盖住
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    const u = getUser();
    if (!u) {
      router.push("/login");
      return;
    }
    setUser(u);
    initTheme();
  }, []);

  // 打开/窗口变化时, 按头像按钮位置算出弹层应出现的视口坐标
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setMenuPos({ top: r.bottom + 8, right: window.innerWidth - r.right });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  if (!user) return null;

  const close = () => setOpen(false);

  const groups: MenuGroup[] = [
    {
      title: "账户",
      items: [
        {
          icon: UserCog,
          label: "个人资料",
          description: "修改昵称/密码",
          onClick: () => {
            close();
            setProfileOpen(true);
          },
        },
        {
          icon: Palette,
          label: "主题设置",
          description: "切换明暗模式 / 主题色",
          onClick: () => {
            close();
            setThemeOpen(true);
          },
        },
        {
          icon: MessageSquare,
          label: "问题反馈",
          description: "遇到问题或建议告诉我们",
          onClick: () => {
            close();
            setFeedbackOpen(true);
          },
        },
      ],
    },
    {
      title: "工作区",
      items: [
        {
          icon: Sparkles,
          label: "对话工坊",
          description: "Agent 多轮对话编辑",
          onClick: () => {
            close();
            router.push("/chat-studio");
          },
        },
        {
          icon: FileBarChart,
          label: "速转工具",
          description: "Prompt 转换器",
          onClick: () => {
            close();
            router.push("/tools/prompt-converter");
          },
        },
        {
          icon: Brain,
          label: "记忆设置",
          description: "管理 AI 长期记忆",
          onClick: () => {
            close();
            router.push("/settings/memories");
          },
        },
        {
          icon: Trash2,
          label: "回收站",
          description: "已删除草稿",
          onClick: () => {
            close();
            router.push("/trash");
          },
        },
      ],
    },
  ];

  if (isAdmin()) {
    groups.push({
      title: "管理",
      items: [
        {
          icon: Shield,
          label: "管理后台",
          description: "系统配置/用户/统计",
          href: "/admin-ui/",
        },
      ],
    });
  }

  const initials = (user.display_name || user.username || "?")[0].toUpperCase();

  return (
    <>
      {/* 版本切换按钮紧贴头像左侧 —— 用户要求"一眼可见"，所以不放进下拉菜单。
          外层 flex 保证它与 UserNav 的 relative 容器并排。 */}
      <div className="flex items-center gap-2">
        <VersionSwitcher />
        <div className="relative">
        <button
          ref={btnRef}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 pl-1.5 pr-2 py-1 rounded-full bg-surface-raised hover:bg-surface-overlay border border-line-strong transition group"
          aria-haspopup="true"
          aria-expanded={open}
        >
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary to-cyan flex items-center justify-center text-white font-semibold text-xs shadow-sm">
            {initials}
          </div>
          <span className="text-sm text-ink-primary max-w-[100px] truncate">
            {user.display_name || user.username}
          </span>
          {isAdmin() && (
            <span className="text-[10px] px-1.5 py-0.5 bg-warning/15 border border-warning/40 text-warning rounded font-semibold uppercase tracking-wider">
              admin
            </span>
          )}
          <ChevronDown
            className={`w-3.5 h-3.5 text-ink-muted transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>

        {open && menuPos && typeof document !== "undefined" &&
          createPortal(
          <>
            {/* 遮罩: 点击空白关闭. z 提到很高, 确保盖住页面所有卡片 */}
            <div className="fixed inset-0 z-[9998]" onClick={close} />
            <div
              className="fixed w-72 z-[9999] rounded-xl shadow-2xl backdrop-blur-xl border border-line-strong overflow-hidden bg-surface-elevated/95"
              style={{ top: menuPos.top, right: menuPos.right }}
            >
              {/* 身份卡 */}
              <div className="px-4 py-3 border-b border-line bg-surface-raised/30">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-cyan flex items-center justify-center text-white font-semibold shadow-sm">
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-ink-primary truncate">
                      {user.display_name || user.username}
                    </div>
                    <div className="text-xs text-ink-secondary truncate">
                      {user.username} · {user.role}
                    </div>
                  </div>
                </div>
              </div>

              {/* 分组菜单 */}
              <div className="py-2 max-h-[60vh] overflow-y-auto">
                {groups.map((g) => (
                  <div key={g.title} className="mb-1 last:mb-0">
                    <div className="px-4 pt-2 pb-1 text-[10px] font-bold text-ink-muted uppercase tracking-widest">
                      {g.title}
                    </div>
                    {g.items.map((item, idx) => {
                      const Icon = item.icon;
                      const cls = `w-full flex items-center gap-3 px-4 py-2 transition text-left ${
                        item.danger
                          ? "hover:bg-danger/10 text-danger"
                          : "hover:bg-surface-overlay text-ink-primary"
                      }`;
                      const inner = (
                        <>
                          <Icon
                            className={`w-4 h-4 shrink-0 ${
                              item.danger ? "text-danger" : "text-ink-muted"
                            }`}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium leading-tight">
                              {item.label}
                            </div>
                            {item.description && (
                              <div className="text-[11px] text-ink-muted leading-tight mt-0.5">
                                {item.description}
                              </div>
                            )}
                          </div>
                        </>
                      );
                      if (item.href) {
                        return (
                          <a key={idx} href={item.href?.startsWith("/") ? "/jubengongfang" + item.href : item.href} className={cls}>
                            {inner}
                          </a>
                        );
                      }
                      return (
                        <button key={idx} onClick={item.onClick} className={cls}>
                          {inner}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>

              {/* 登出 */}
              <div className="border-t border-line">
                <button
                  onClick={() => logout()}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-danger/10 text-danger transition"
                >
                  <LogOut className="w-4 h-4" />
                  <span className="text-sm font-medium">登出</span>
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
        </div>
      </div>

      {/* 用 Portal 渲染到 body, 绕过 TopBar 的 backdrop-blur 形成的 containing block 陷阱.
         按 CSS Filter Effects spec, 祖先有 backdrop-filter 时, fixed 子元素以祖先为参考系而非 viewport,
         会导致 modal 被关进 TopBar 64px 高度内, 只能看到顶部标题. */}
      {typeof document !== "undefined" &&
        themeOpen &&
        createPortal(
          <ThemeSelector onClose={() => setThemeOpen(false)} />,
          document.body,
        )}
      {typeof document !== "undefined" &&
        profileOpen &&
        createPortal(
          <ProfileModal
            onClose={() => {
              setProfileOpen(false);
              const u = getUser();
              if (u) setUser(u);
            }}
          />,
          document.body,
        )}
      {/* 问题反馈弹窗(受控): 由头像下拉菜单的"问题反馈"打开。
         ⚠️ 必须 Portal 到 body: 顶栏 header 的 backdrop-blur 会创建 containing block,
         使内部 position:fixed 的弹窗相对 header 定位并被裁剪(显得"点了没反应")。 */}
      {typeof document !== "undefined" &&
        feedbackOpen &&
        createPortal(
          <FeedbackWidget controlledOpen={feedbackOpen} onClose={() => setFeedbackOpen(false)} />,
          document.body,
        )}
    </>
  );
}
