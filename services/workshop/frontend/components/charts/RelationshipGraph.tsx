'use client';
import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * RelationshipGraph — 角色关系网 (PLAN §15 / 15 号设计图)
 *
 * 纯 SVG 实现, 无 react-flow / d3-force 等重依赖。
 *  - 顶点按圆周均匀分布 (足以覆盖 ≤30 个角色的场景)
 *  - 边的颜色由 relation_type 推导: 家人=绿 / 恋人=粉 / 朋友=蓝 / 敌人=红 / 同事=灰 / 默认=紫
 *  - 边的粗度由 strength (1-5) 推导
 *  - 每个顶点是一个圆 + 名字标签, 角色为主角时高亮
 */

export type GraphCharacter = {
  id: number;
  name: string;
  role?: string;
  avatar_url?: string;
};

export type GraphRelationship = {
  from_character_id: number;
  to_character_id: number;
  relation_type?: string;
  strength?: number; // 1-5
  description?: string;
};

const RELATION_COLOR: Record<string, string> = {
  家人: '#10b981',
  恋人: '#ec4899',
  朋友: '#3b82f6',
  敌人: '#ef4444',
  同事: '#94a3b8',
  师徒: '#f59e0b',
  亲属: '#10b981',
};

const RELATION_FALLBACK = '#7c3aed';

function colorForRelation(rel?: string): string {
  if (!rel) return RELATION_FALLBACK;
  for (const k of Object.keys(RELATION_COLOR)) {
    if (rel.includes(k)) return RELATION_COLOR[k];
  }
  return RELATION_FALLBACK;
}

export function RelationshipGraph({
  characters,
  relationships,
  size = 480,
  className,
}: {
  characters: GraphCharacter[];
  relationships: GraphRelationship[];
  size?: number;
  className?: string;
}) {
  if (characters.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center text-ink-muted text-sm',
          className,
        )}
        style={{ width: size, height: size / 2 }}
      >
        暂无角色
      </div>
    );
  }

  const center = size / 2;
  const radius = (size / 2) * 0.78;
  const N = characters.length;

  // 角色坐标: 圆周均匀分布 (单角色时居中)
  const positions = new Map<number, { x: number; y: number }>();
  characters.forEach((c, i) => {
    if (N === 1) {
      positions.set(c.id, { x: center, y: center });
    } else {
      const angle = (Math.PI * 2 * i) / N - Math.PI / 2;
      positions.set(c.id, {
        x: center + radius * Math.cos(angle),
        y: center + radius * Math.sin(angle),
      });
    }
  });

  // 主角识别: role 含"主"
  const isProtagonist = (c: GraphCharacter) =>
    !!c.role && (c.role.includes('主') || c.role === 'protagonist');

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('select-none', className)}
    >
      {/* 边 */}
      {relationships.map((r, idx) => {
        const a = positions.get(r.from_character_id);
        const b = positions.get(r.to_character_id);
        if (!a || !b) return null;
        const stroke = colorForRelation(r.relation_type);
        const w = Math.max(1, Math.min(5, r.strength ?? 2));
        // 中点放标签
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        return (
          <g key={idx}>
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={stroke}
              strokeWidth={w}
              strokeOpacity={0.6}
              strokeLinecap="round"
            />
            {r.relation_type && (
              <g transform={`translate(${mx}, ${my})`}>
                <rect
                  x="-22"
                  y="-9"
                  width="44"
                  height="18"
                  rx="9"
                  fill="rgb(20,21,30)"
                  stroke={stroke}
                  strokeWidth="1"
                />
                <text
                  x="0"
                  y="0"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize="10"
                  fill={stroke}
                  fontWeight="600"
                >
                  {r.relation_type.slice(0, 4)}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* 顶点 */}
      {characters.map((c) => {
        const p = positions.get(c.id)!;
        const protag = isProtagonist(c);
        const r = protag ? 26 : 22;
        const initials = (c.name || '?')[0];
        return (
          <g key={c.id} transform={`translate(${p.x}, ${p.y})`}>
            {protag && (
              <circle
                r={r + 4}
                fill="none"
                stroke="rgb(124,58,237)"
                strokeWidth="2"
                strokeDasharray="4 3"
                opacity="0.6"
              />
            )}
            <circle
              r={r}
              fill={protag ? 'rgb(124,58,237)' : 'rgb(40,42,55)'}
              stroke={protag ? 'rgb(167,139,250)' : 'rgb(71,85,105)'}
              strokeWidth="2"
            />
            <text
              x="0"
              y="0"
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="14"
              fill="white"
              fontWeight="700"
            >
              {initials}
            </text>
            <text
              x="0"
              y={r + 14}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="11"
              fill="rgb(203,213,225)"
              fontWeight="600"
            >
              {c.name}
            </text>
            {c.role && (
              <text
                x="0"
                y={r + 27}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize="9"
                fill="rgb(148,163,184)"
              >
                {c.role}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
