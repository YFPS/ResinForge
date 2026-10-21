/* 打桌面安装包，并用本地私钥给更新包签名。私钥不入库。 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const keyPath = path.join(root, 'src-tauri', 'keys', 'resinforge.key');
const passPath = path.join(root, 'src-tauri', 'keys', 'password.txt');
const env = { ...process.env };

if (fs.existsSync(keyPath)) {
  env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(keyPath, 'utf8');
  if (fs.existsSync(passPath)) env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = fs.readFileSync(passPath, 'utf8').trim();
  console.log('将使用本地签名私钥为更新包签名');
} else {
  console.warn('未找到 src-tauri/keys/resinforge.key。安装包可以打，但在线更新无法校验签名。');
}

const build = spawnSync('npx', ['tauri', 'build'], { stdio: 'inherit', env, shell: true });
if ((build.status ?? 1) !== 0) process.exit(build.status ?? 1);

const manifest = spawnSync('node', ['scripts/write-update-manifest.mjs'], { stdio: 'inherit', env, shell: true });
process.exit(manifest.status ?? 0);
