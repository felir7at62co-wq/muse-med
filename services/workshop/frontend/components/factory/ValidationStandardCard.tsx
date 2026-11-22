"use client";
import { Card, Textarea } from "@/components/ui";
import { Info } from "lucide-react";

type ValidationStandardCardProps = {
  customCriteria: string;
  onCustomCriteriaChange: (value: string) => void;
};

export function ValidationStandardCard({
  customCriteria,
  onCustomCriteriaChange,
}: ValidationStandardCardProps) {
  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold mb-4">
        剧本校验标准 <span className="text-sm text-gray-400 font-normal">(自动执行)</span>
      </h2>
      
      {/* V2.0检查清单说明 */}
      <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-900 space-y-2">
            <p className="font-medium">采用V2.0结构化检查清单(14项)</p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <p className="font-medium mb-1">必须项(11项):</p>
                <ul className="space-y-0.5 text-blue-800">
                  <li>• 明确集数、集数合理、结构完整</li>
                  <li>• 主线清晰、冲突递进、结局合理</li>
                  <li>• 主角明确、人设自洽、关系合理</li>
                  <li>• 时间线连贯、逻辑自洽、因果关系</li>
                </ul>
              </div>
              <div>
                <p className="font-medium mb-1">建议项(3项):</p>
                <ul className="space-y-0.5 text-blue-800">
                  <li>• 情感线存在</li>
                  <li>• 反派有动机</li>
                  <li>• 节奏合理</li>
                </ul>
              </div>
            </div>
            <p className="text-xs text-blue-700 mt-2">
              ✓ 所有11个必须项都pass → 进入裂变<br/>
              ✗ 优化3次后仍有必须项fail → 跳过该产物
            </p>
          </div>
        </div>
      </div>
      
      {/* 额外校验标准 */}
      <div className="mt-4">
        <label className="text-sm font-medium text-ink-primary block mb-1">
          额外校验标准 <span className="text-gray-400 font-normal">(选填)</span>
        </label>
        <Textarea
          value={customCriteria}
          onChange={(e) => onCustomCriteriaChange(e.target.value)}
          placeholder="在标准14项之外,您还可以补充特定要求,如:必须包含商战元素、必须有反转情节..."
          rows={3}
          className="w-full"
        />
        <p className="text-xs text-gray-500 mt-1">
          留空则仅执行标准14项检查
        </p>
      </div>
    </Card>
  );
}