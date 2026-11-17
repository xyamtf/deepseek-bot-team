@echo off
rem 双击安装：下载最新发布包并解压，然后按提示把它加成 DSH 插件。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
