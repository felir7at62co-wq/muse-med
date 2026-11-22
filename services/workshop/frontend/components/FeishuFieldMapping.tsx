"use client";
import { Database } from "lucide-react";

interface FeishuFieldMappingProps {
  url: string;
  textFieldName: string;
  fileFieldName: string;
  onUrlChange: (value: string) => void;
  onTextFieldChange: (value: string) => void;
  onFileFieldChange: (value: string) => void;
}

export function FeishuFieldMapping({
  url,
  textFieldName,
  fileFieldName,
  onUrlChange,
  onTextFieldChange,
  onFileFieldChange,
}: FeishuFieldMappingProps) {
  return (
    <div className="space-y-3 p-4 bg-blue-50 rounded-lg border border-blue-200">
      <h4 className="font-medium flex items-center gap-2 text-sm">
        <Database className="w-4 h-4 text-blue-600" />
        飞书字段映射
      </h4>
      
      <div>
        <label className="text-sm font-medium text-ink-primary block mb-1">
          飞书表格链接
        </label>
        <input
          type="url"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="https://xxx.feishu.cn/base/..."
          className="w-full px-3 py-2 text-sm border border-line rounded-lg focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>
      
      <div>
        <label className="text-sm font-medium text-ink-primary block mb-1">
          文本字段名
          <span className="text-xs text-gray-500 font-normal ml-2">
            (系统将从这一列读取文本内容)
          </span>
        </label>
        <input
          type="text"
          value={textFieldName}
          onChange={(e) => onTextFieldChange(e.target.value)}
          placeholder="如: 剧本内容、小说文本、正文"
          className="w-full px-3 py-2 text-sm border border-line rounded-lg focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>
      
      <div>
        <label className="text-sm font-medium text-ink-primary block mb-1">
          文件字段名 (可选)
          <span className="text-xs text-gray-500 font-normal ml-2">
            (系统将从这一列下载附件)
          </span>
        </label>
        <input
          type="text"
          value={fileFieldName}
          onChange={(e) => onFileFieldChange(e.target.value)}
          placeholder="如: 附件、文档、剧本文件"
          className="w-full px-3 py-2 text-sm border border-line rounded-lg focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>
      
      <div className="text-xs text-gray-600 bg-white p-2 rounded border border-blue-100">
        💡 <span className="font-medium">提示:</span> 字段名必须与飞书表格中的列名完全匹配
      </div>
    </div>
  );
}