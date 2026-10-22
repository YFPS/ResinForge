/**
 * 从 Arc UI registry（https://uiarc.dev/r/<name>.json）拉取组件源码到 src/components/arc/。
 *
 * 用法：
 *   node scripts/fetch-arc.mjs                    拉取 ITEMS 全部组件（已存在的文件跳过，保护下方 PATCHED 里的就地补丁）
 *   node scripts/fetch-arc.mjs split-button ...   只拉取指定组件（及其缺失的 registry 依赖）
 *   加 --force                                    覆盖已存在的文件（之后须手动重放 PATCHED 补丁）
 * registryDependencies 递归解析。
 * 新增组件只需在 ITEMS 里加名字（名字即 uiarc.dev/r/<name>.json 的 <name>）。
 *
 * 组件源码原样落盘（含 .tsx 扩展名与 TS 类型；Vite 只转译不检查类型）。
 * 若某个组件在 React 18 下运行时不兼容需打补丁，在下方 PATCHED 里登记说明。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'src/components/arc');
const REGISTRY = 'https://uiarc.dev/r';

const ITEMS = [
  'arc-foundation',
  'button',
  'card',
  'segmented-control',
  'number-field',
  'switch',
  'checkbox',
  'slider',
  'elastic-slider',
  'select',
  'radio-cards',
  'tabs',
  'accordion',
  'expandable-card',
  'toast',
  'tooltip',
  'dropdown-menu',
  'drawer',
  'dialog',
  'popover',
  'progress',
  'badge',
  'scroll-area',
  'empty-state',
  'animated-counter',
  'skeleton',
  'alert',
  'file-dropzone',
  /* 顶栏 / 侧栏重做新增 */
  'split-button',
  'theme-switch',
  'command-palette',
  'icon-morph',
  /* redesign.html 的支撑模板选择用 */
  'chip-group',
];

/** 已就地打补丁的组件（React 18 兼容等），改动需在 fetch 后手动重放 */
const PATCHED = {
  'button/button.tsx':
    'LabelPhase 由「函数组件直接接收 ref 参数」（React 19 ref-as-prop 写法）改为 forwardRef 包裹；' +
    '否则 React 18 下 AnimatePresence 的 PopChild 传 ref 会触发 "Function components cannot be given refs" 警告。',
  'slider/slider.tsx':
    'partsOf 里分隔符的 key 由 `g${place}${char}` 改为 `g${place}-${index}${char}`；' +
    '原 key 在同一文本出现两个相同分隔符时会重复（如 format 输出 "634 / 634" 的两个空格），React 报重复 key 警告。',
  'badge/badge.tsx':
    'Swap 改为 forwardRef。React 18 下 AnimatePresence 的 PopChild 传 ref 会警告 Function components cannot be given refs。',
  'alert/alert.tsx':
    'Swap 改为 forwardRef，原因同 badge：React 18 不支持函数组件直接接收 ref。',
  'progress/progress.tsx':
    'Swap 改为 forwardRef，原因同 badge：React 18 不支持函数组件直接接收 ref（进度条文字换 label 时报警告）。',
  'number-field/number-field.tsx':
    'scrub 的指针事件同时绑在数值区域上（不只是标签），拖完一次后抑制紧接着的点击，避免把输入框重新选中。',
  'command-palette/command-palette.tsx':
    '界面文案本地化：默认分组 Actions → 操作、空结果提示与清除 / 关闭按钮的中文名；右侧快捷键徽标按平台显示 ⌘ K 或 Ctrl K。',
  'card/card.tsx':
    '快速查看的遮罩不再用 AnimatePresence 包 Radix Dialog.Overlay（React 18 下会给函数组件传 ref 报警告），改为静态 Overlay；' +
    '面板 morph 与关闭回落逻辑不变。',
  'elastic-slider/elastic-slider.tsx':
    '两端图标的橡皮筋位移封顶 ICON_NUDGE（10px）。轨道仍可拉出 STRETCH，图标再远就会画出对话框。',
};

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter(a => !a.startsWith('--'));

const seen = new Set();
const npmDeps = new Set();
const written = [];
const skipped = [];

/** @components/arc/<rest> → src/components/arc/<rest> */
function resolveTarget(target) {
  const m = /^@components\/arc\/(.+)$/.exec(target || '');
  if (!m) throw new Error(`未知 target：${target}`);
  return path.join(OUT, m[1]);
}

async function fetchItem(name) {
  if (seen.has(name)) return;
  seen.add(name);
  const res = await fetch(`${REGISTRY}/${name}.json`);
  if (!res.ok) throw new Error(`${name} 拉取失败：HTTP ${res.status}`);
  const item = await res.json();
  for (const d of item.dependencies || []) npmDeps.add(d);
  for (const f of item.files || []) {
    const dest = resolveTarget(f.target || f.path);
    const rel = path.relative(ROOT, dest).replaceAll('\\', '/');
    // 默认不覆盖已有文件：本地补丁（PATCHED）与共享依赖（button、motion-tokens 等）保持原样
    if (!force && await fs.access(dest).then(() => true, () => false)) { skipped.push(rel); continue; }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, f.content, 'utf8');
    written.push(rel);
  }
  for (const dep of item.registryDependencies || []) {
    const depName = dep.split('/').pop().replace(/\.json$/, '');
    await fetchItem(depName);
  }
}

for (const name of only.length ? only : ITEMS) await fetchItem(name);

written.sort();
console.log(`写入 ${written.length} 个文件 → src/components/arc/`);
for (const f of written) console.log('  ' + f);
if (skipped.length) console.log(`跳过 ${skipped.length} 个已存在文件（加 --force 覆盖）`);
console.log('\nnpm 依赖：' + [...npmDeps].sort().join(' '));
const patchedNames = Object.keys(PATCHED);
if (patchedNames.length) {
  console.log('\n已打补丁的组件（fetch 后需手动重放）：');
  for (const p of patchedNames) console.log(`  ${p}：${PATCHED[p]}`);
}
