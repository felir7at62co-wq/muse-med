'use client';
import * as React from 'react';
import { Sparkles } from 'lucide-react';
import {
  Drawer,
  Button,
  Input,
  Textarea,
  FormField,
  useToast,
} from '@/components/ui';
import { ModelSelect } from '@/components/ModelSelect';
import { saveModelPreference } from '@/lib/modelCatalog';

const PRESET_WORDS = [
  { label: '短篇', v: 3000 },
  { label: '标准', v: 5000 },
  { label: '中长', v: 7000 },
  { label: '长篇', v: 10000 },
];

export type DraftCreatePayload = {
  title: string;
  user_input: string;
  episode_count: number;
  chapter_word_target: number;
  model_provider: string;
};

export type DraftCreateDrawerProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: DraftCreatePayload) => Promise<void>;
};

/**
 * DraftCreateDrawer — 新建草稿右侧抽屉（PLAN §5.6）
 *
 * 替代旧版 page.tsx 内联表单。
 */
export function DraftCreateDrawer({ open, onClose, onSubmit }: DraftCreateDrawerProps) {
  const toast = useToast();
  const [title, setTitle] = React.useState('');
  const [userInput, setUserInput] = React.useState('');
  const [model, setModel] = React.useState('gemini');
  const [episodes, setEpisodes] = React.useState(3);
  const [words, setWords] = React.useState(5000);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setTitle('');
      setUserInput('');
      setEpisodes(3);
      setWords(5000);
      setModel('gemini');
      setSubmitting(false);
    }
  }, [open]);

  const titleErr = title.trim() ? '' : '标题不能为空';
  const inputErr = userInput.trim() ? '' : '请简述故事概要';
  const valid = !titleErr && !inputErr && episodes > 0 && words > 0;

  /**
   * 记住用户选的模型，下次新建草稿默认就是它。
   *
   * 为什么放在这里而不是 ModelSelect 内部：只有"无副作用"的选择场景才该回写。
   * 草稿页顶部那个选择器的 onChange 会弹确认框 + PATCH 草稿（见 ModelSelect 的
   * alignOnLoad 注释），在那里回写会变成一进页面就改用户偏好。
   */
  const rememberModel = (v: string) => {
    if (!v || !v.includes(':')) return; // 裸厂商名（尚未对齐到具体型号）不值得存
    void saveModelPreference(v); // 失败已在内部 warn，不打扰用户
  };

  const handleSubmit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        user_input: userInput.trim(),
        episode_count: episodes,
        chapter_word_target: words,
        model_provider: model,
      });
    } catch (e) {
      toast.error({ title: '创建失败', description: (e as Error).message || '请稍后重试' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="right"
      size="md"
      title="新建草稿"
      description="填写基本信息后会跳转到大纲生成页"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            loading={submitting}
            disabled={!valid}
            leftIcon={<Sparkles className="w-4 h-4" />}
          >
            创建并进入大纲
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label="标题" required error={title ? '' : titleErr}>
          <Input
            placeholder="例如：庶女掌权录"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            invalid={!!title && !!titleErr}
            autoFocus
          />
        </FormField>

        <FormField
          label="故事概要"
          required
          hint="一句话讲清主角 / 冲突 / 走向，AI 据此生成大纲"
          error={userInput ? '' : inputErr}
        >
          <Textarea
            placeholder="例如：庶女女主重生回少年时，誓要让前世害她的人付出代价..."
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            rows={5}
            autoSize
            maxRows={10}
            invalid={!!userInput && !!inputErr}
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="AI 模型">
            <ModelSelect
              value={model}
              onChange={(v, source) => {
                setModel(v);
                // 只有用户真的点了型号才记；'align' 是挂载时的自动对齐，
                // 记它等于把平台默认写死成个人偏好（见 ModelSelect 顶部注释）
                if (source === 'user') rememberModel(v);
              }}
              label={null}
              showHint={false}
              className="w-full"
            />
          </FormField>

          <FormField label="剧集数量" hint="1-500 集">
            <Input
              type="number"
              min={1}
              max={500}
              step={1}
              value={episodes || ''}
              onChange={(e) => {
                const n = parseInt(e.target.value);
                if (Number.isNaN(n)) {
                  setEpisodes(0);
                  return;
                }
                setEpisodes(Math.min(500, Math.max(0, n)));
              }}
              onBlur={() => {
                if (!episodes) setEpisodes(3);
              }}
            />
          </FormField>
        </div>

        <FormField
          label="每章字数"
          endAdornment={<span>{words} 字</span>}
          hint="允许 ±20% 浮动"
        >
          <div className="flex flex-col gap-2">
            <Input
              type="number"
              min={1000}
              max={20000}
              step={500}
              value={words || ''}
              onChange={(e) => {
                const n = parseInt(e.target.value);
                if (Number.isNaN(n)) {
                  setWords(0);
                  return;
                }
                setWords(Math.min(20000, Math.max(0, n)));
              }}
              onBlur={() => {
                if (!words) setWords(5000);
              }}
            />
            <div className="flex flex-wrap gap-2">
              {PRESET_WORDS.map((p) => (
                <Button
                  key={p.v}
                  variant={words === p.v ? 'primary' : 'outline'}
                  size="sm"
                  onClick={() => setWords(p.v)}
                  type="button"
                >
                  {p.label} {p.v}
                </Button>
              ))}
            </div>
          </div>
        </FormField>
      </div>
    </Drawer>
  );
}
