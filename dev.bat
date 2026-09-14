@echo off
rem 网络盘（UNC）兼容启动器：pushd 把脚本所在目录映射为盘符后再跑 npm
rem （cmd 不支持 UNC 作工作目录；vite 配置里已开 resolve.preserveSymlinks 兼容映射盘符）
pushd %~dp0 || exit /b 1
npm run dev
