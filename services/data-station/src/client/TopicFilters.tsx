import { useState } from 'react';
import { X } from 'lucide-react';
import type { TopicFacets } from '../shared/types';

/** Topic chips of the shown scope; topics without works are hidden and long groups collapse after eight. */
export function TopicFilters({ groups, selected, onSelect }: { groups: TopicFacets['groups']; selected: string; onSelect: (id: string) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const visibleGroups = groups.map(group => ({ ...group, items: group.items.filter(item => item.count > 0) })).filter(group => group.items.length > 0);
  const selectedItem = visibleGroups.flatMap(group => group.items).find(item => item.id === selected);
  return <div className="topic-filters" aria-label="细分题材筛选" data-testid="topic-filters">
    <div className="topic-filter-heading"><strong>细分题材</strong>{selected && <button className="clear-topic" onClick={() => onSelect('')}>清除题材筛选{selectedItem && ` · ${selectedItem.label}`}<X size={12} /></button>}</div>
    {visibleGroups.length ? visibleGroups.map(group => {
      const open = expanded.has(group.id);
      const displayed = open ? group.items : group.items.slice(0, 8);
      return <div key={group.id} className="topic-filter-group"><span className="topic-group-label">{group.label}</span><div className="topic-chip-list">{displayed.map(item => <button key={item.id} className={`topic-chip${selected === item.id ? ' active' : ''}`} aria-pressed={selected === item.id} onClick={() => onSelect(selected === item.id ? '' : item.id)}>{item.label}<small>{item.count}</small></button>)}{group.items.length > 8 && <button className="topic-more" onClick={() => setExpanded(current => { const next = new Set(current); open ? next.delete(group.id) : next.add(group.id); return next; })}>{open ? '收起' : `更多 ${group.items.length - 8}`}</button>}</div></div>;
    }) : <p className="topic-filter-empty">当前范围还没有可展示的细分题材。</p>}
  </div>;
}
