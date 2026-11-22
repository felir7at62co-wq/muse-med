"use client";
import { useEffect, useState } from "react";
import { X, Info, AlertTriangle, AlertCircle } from "lucide-react";

type Announcement = {
  id: number;
  title: string;
  content: string;
  type: "info" | "warning" | "error";
};

const DISMISS_KEY = "drama_dismissed_announcements";

export function AnnouncementBar() {
  const [anns, setAnns] = useState<Announcement[]>([]);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  useEffect(() => {
    // 读取已关闭
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      if (raw) setDismissed(new Set(JSON.parse(raw)));
    } catch {}

    // 拉取公告
    fetch("/jubengongfang/v1/public/announcements")
      .then((r) => r.ok ? r.json() : [])
      .then((data) => setAnns(data || []))
      .catch(() => {});
  }, []);

  const visible = anns.filter((a) => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  function dismiss(id: number) {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
  }

  const styles = {
    info: { bg: "bg-info/15 border-info/40", icon: <Info className="w-4 h-4 text-info" />, text: "text-info" },
    warning: { bg: "bg-warning/15 border-warning/40", icon: <AlertTriangle className="w-4 h-4 text-warning" />, text: "text-warning" },
    error: { bg: "bg-danger/20 border-danger/40", icon: <AlertCircle className="w-4 h-4 text-danger" />, text: "text-danger" },
  };

  return (
    <div className="sticky top-0 z-20 w-full">
      {visible.map((a) => {
        const s = styles[a.type] || styles.info;
        return (
          <div
            key={a.id}
            className={`w-full border-b ${s.bg} ${s.text} px-4 py-2 flex items-start gap-2 text-sm`}
          >
            <span className="shrink-0 mt-0.5">{s.icon}</span>
            <div className="flex-1">
              <span className="font-semibold mr-2">{a.title}</span>
              <span className="opacity-90">{a.content}</span>
            </div>
            <button
              onClick={() => dismiss(a.id)}
              className="shrink-0 hover:opacity-100 opacity-60 transition p-1"
              title="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
