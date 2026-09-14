@echo off
rem 网络盘（UNC）兼容构建器：pushd 把脚本所在目录映射为盘符后再跑 npm
pushd %~dp0 || exit /b 1
npm run build
