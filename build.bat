@echo off
rem UNC builder: pushd maps script dir to a drive letter, then run npm.
pushd %~dp0 || exit /b 1
npm run build
