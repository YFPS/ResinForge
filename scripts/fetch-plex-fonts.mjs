/**
 * 本地化 IBM Plex Sans / Mono（只取 latin 子集）：下载 woff2 到 public/fonts/，生成 src/redesign/fonts.css。
 * 运行：node scripts/fetch-plex-fonts.mjs
 * 设计稿（framed-sheet）指定的正文与数字字体都是 IBM Plex；中文由 PingFang SC / 微软雅黑 回落。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'public/fonts');
const CSS_OUT = path.join(ROOT, 'src/redesign/fonts.css');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const URL_CSS = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap';

const css = await (await fetch(URL_CSS, { headers: { 'User-Agent': UA } })).text();
/* 按注释切块：只留 /* latin *\/ 的那一块（每块一个 @font-face） */
const blocks = css.split('/*').slice(1).map(chunk => {
  const label = chunk.slice(0, chunk.indexOf('*/')).trim();
  const face = chunk.slice(chunk.indexOf('*/') + 2);
  const start = face.indexOf('@font-face');
  return start < 0 ? null : { label, face: face.slice(start) };
}).filter(Boolean).filter(b => b.label === 'latin');

await fs.mkdir(OUT_DIR, { recursive: true });
const faces = [];
for (const { face } of blocks) {
  const family = /font-family:\s*'([^']+)'/.exec(face)[1];
  const weight = /font-weight:\s*(\d+)/.exec(face)[1];
  const url = /url\((https:[^)]+\.woff2)\)/.exec(face)[1];
  const file = `${family.toLowerCase().replace(/\s+/g, '-')}-${weight}-latin.woff2`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  await fs.writeFile(path.join(OUT_DIR, file), Buffer.from(await res.arrayBuffer()));
  faces.push({ family, weight, file });
  console.log(`✓ ${family} ${weight} → public/fonts/${file}`);
}

const cssText = `/* 由 scripts/fetch-plex-fonts.mjs 生成；勿手改。IBM Plex Sans / Mono，latin 子集，OFL-1.1。 */
${faces.map(f => `@font-face {
  font-family: '${f.family}';
  font-style: normal;
  font-weight: ${f.weight};
  font-display: swap;
  src: url('/fonts/${f.file}') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}`).join('\n\n')}
`;
await fs.writeFile(CSS_OUT, cssText, 'utf8');
console.log(`\n写入 ${faces.length} 个 @font-face → src/redesign/fonts.css`);
