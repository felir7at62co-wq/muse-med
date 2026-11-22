"use client";
import { Card } from "@/components/ui";

export type VideoConfig = {
  style: "normal" | "comedy" | "suspense";
  duration: 30 | 60 | 90;
  quality: "720p" | "1080p" | "2k";
  image_style: string;
  voice_mode: "auto" | "male" | "female";
};

type VideoConfigCardProps = {
  config: VideoConfig;
  onChange: (config: VideoConfig) => void;
};

export function VideoConfigCard({ config, onChange }: VideoConfigCardProps) {
  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold mb-4">视频参数</h3>
      
      <div className="grid grid-cols-2 gap-4">
        {/* 风格 */}
        <div>
          <label className="text-sm font-medium text-ink-primary block mb-1">
            风格
          </label>
          <select
            value={config.style}
            onChange={(e) => onChange({ ...config, style: e.target.value as VideoConfig["style"] })}
            className="w-full px-3 py-2 text-sm border border-line rounded-lg focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="normal">正剧</option>
            <option value="comedy">喜剧</option>
            <option value="suspense">悬疑</option>
          </select>
        </div>

        {/* 时长 */}
        <div>
          <label className="text-sm font-medium text-ink-primary block mb-1">
            时长
          </label>
          <select
            value={config.duration}
            onChange={(e) => onChange({ ...config, duration: parseInt(e.target.value) as VideoConfig["duration"] })}
            className="w-full px-3 py-2 text-sm border border-line rounded-lg focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="30">30秒</option>
            <option value="60">60秒</option>
            <option value="90">90秒</option>
          </select>
        </div>

        {/* 分辨率 */}
        <div>
          <label className="text-sm font-medium text-ink-primary block mb-1">
            分辨率
          </label>
          <select
            value={config.quality}
            onChange={(e) => onChange({ ...config, quality: e.target.value as VideoConfig["quality"] })}
            className="w-full px-3 py-2 text-sm border border-line rounded-lg focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="720p">720p</option>
            <option value="1080p">1080p (推荐)</option>
            <option value="2k">2K</option>
          </select>
        </div>

        {/* 配音 */}
        <div>
          <label className="text-sm font-medium text-ink-primary block mb-1">
            配音
          </label>
          <select
            value={config.voice_mode}
            onChange={(e) => onChange({ ...config, voice_mode: e.target.value as VideoConfig["voice_mode"] })}
            className="w-full px-3 py-2 text-sm border border-line rounded-lg focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="auto">智能选择</option>
            <option value="male">男声</option>
            <option value="female">女声</option>
          </select>
        </div>
      </div>

      {/* 画面风格(选填) */}
      <div className="mt-4">
        <label className="text-sm font-medium text-ink-primary block mb-1">
          画面风格 <span className="text-gray-400 font-normal">(选填)</span>
        </label>
        <input
          type="text"
          value={config.image_style}
          onChange={(e) => onChange({ ...config, image_style: e.target.value })}
          placeholder="如:水墨画、赛博朋克、写实风格..."
          className="w-full px-3 py-2 text-sm border border-line rounded-lg focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        <p className="text-xs text-gray-500 mt-1">
          留空则使用默认画面风格
        </p>
      </div>
    </Card>
  );
}