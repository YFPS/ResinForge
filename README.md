# ResinForge

光固化（SLA / DLP / LCD）自动支撑。模型载入、朝向、切片分析和支撑生成都在本机完成，不会上传。

浏览器版用 Vite + React。桌面版用 Tauri 2，打出 Windows 安装包。

当前版本：0.4.0。许可：[MIT](LICENSE)。更新内容见 [CHANGELOG.md](CHANGELOG.md)。

## 浏览器里跑

需要 Node.js 18 或更新版本。

```bash
npm install
npm run dev
```

打开 http://127.0.0.1:8123/ ，会进入工作室界面（`studio.html`）。

## 桌面版

```bash
npm run desktop:dev      # 开发窗口
npm run desktop:build    # 安装包
```

安装包在 `src-tauri/target/release/bundle/nsis/`。在线更新的签名私钥放在 `src-tauri/keys/`，这个目录不进仓库。没有私钥时安装包仍能打出来，但不能当作可校验的更新发布。

Windows 上需要 Rust stable（MSVC）和 VS 2022 的 C++ 生成工具。WebView2 使用系统自带的运行库。

## 仓库里没有的东西

`2B - 1_12/` 是第三方手办网格，体积大，不能再分发，所以没有放进这个仓库。内置的环面结、蘑菇、双层平台、悬臂雕像和正方体不依赖这些文件。

## 发布

标记为 `v0.4.0` 的安装包在 [Releases](https://github.com/YFPS/ResinForge/releases)。桌面版从 `releases/latest/download/latest.json` 检查更新。
