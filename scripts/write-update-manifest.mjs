/* 根据刚打出的安装包和签名，写 latest.json。
   放到 Gitea 每个发行版的附件里，应用启动时从
   releases/latest/download/latest.json 读取。
   安装包地址可用环境变量 UPDATE_BASE_URL 覆盖。 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const dir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
if (!fs.existsSync(dir)) {
  console.warn('没有找到 nsis 目录，跳过 latest.json');
  process.exit(0);
}

const sigName = fs.readdirSync(dir).find(name => name.endsWith('.sig') && name.includes(version));
if (!sigName) {
  console.warn('没有找到更新签名。这次安装包不能作为在线更新发布。');
  process.exit(0);
}
const fileName = sigName.slice(0, -4);
const base = (process.env.UPDATE_BASE_URL || `http://82.157.179.191:3000/admin/open-support/releases/download/v${version}`).replace(/\/$/, '');
const manifest = {
  version,
  notes: process.env.UPDATE_NOTES || '',
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: fs.readFileSync(path.join(dir, sigName), 'utf8').trim(),
      url: `${base}/${fileName}`,
    },
  },
};
const out = path.join(dir, 'latest.json');
fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log('已写出更新清单', out);
