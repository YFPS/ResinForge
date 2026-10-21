@echo off
rem UNC launcher: pushd maps script dir to a drive letter, then run npm.
rem (cmd does not support UNC cwd; vite.config.js has preserveSymlinks for mapped drives)
pushd %~dp0 || exit /b 1
npm run dev
