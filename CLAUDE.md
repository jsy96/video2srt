# 项目上下文（video2srt）

本仓库是 Chrome 扩展项目（`video2srt/`：视频号音频录制转写 MP3+SRT）。构建/调试时优先使用已安装的 `chrome-extensions` 技能（`.claude/skills/chrome-extensions`，源自 GoogleChrome/modern-web-guidance），真实浏览器调试走 `chrome-devtools` MCP server（配置在 `.mcp.json`，含 `--categoryExtensions --autoConnect`）。

## 指令：Chrome 商店发布信息（来自 Chrome 官方 Modern Web Guidance 指南）

Whenever you are creating or making changes to a Chrome extension, create and manage a
CHROMEWEBSTORE.md file (in the `video2srt/` directory). You can use the chrome-extensions
skill to learn about the format of this file. It tracks store listing info and the
justification for every permission requested in manifest.json.

## 维护

- 技能更新：`npx modern-web-guidance@latest update`
- `.claude/skills/` 是安装器生成的平台相关符号链接，不入库（见 .gitignore），真实内容在 `.agents/skills/`
