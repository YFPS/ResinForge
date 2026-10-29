/* 关于对话框用的版本号和最近更新日志。版本跟 package.json，日志跟仓库里的 CHANGELOG.md。 */
import pkg from '../../package.json';
import changelog from '../../CHANGELOG.md?raw';

export const APP_VERSION = pkg.version;

function plain(text) {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`([^`]+)`/g, '$1');
}

/** 最近几版更新。只取以版本号开头的 ## 标题，更早的「及更早」不放进对话框。 */
export function recentReleases(count = 2) {
  const blocks = String(changelog).split(/\n(?=## )/).filter(block => /^## \d/.test(block.trim()));
  return blocks.slice(0, count).map(block => {
    const lines = block.trim().split('\n');
    const heading = plain(lines[0].replace(/^##\s+/, ''));
    const items = [];
    let paragraph = [];
    const flush = () => {
      const text = plain(paragraph.join(' ')).trim();
      if (text) items.push({ kind: 'p', text });
      paragraph = [];
    };
    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (!line || line === '---') { flush(); continue; }
      if (line.startsWith('### ')) { flush(); items.push({ kind: 'h', text: plain(line.slice(4)) }); continue; }
      if (line.startsWith('- ')) { flush(); items.push({ kind: 'li', text: plain(line.slice(2)) }); continue; }
      paragraph.push(line);
    }
    flush();
    return { heading, items };
  });
}
