# Chrome Web Store Listing — 视频录音转文字 video2srt

> Last Updated: 2026-11-06
> 当前状态：**仅本地开发使用，尚未提交商店**。本文档按上架要求预填，提交前补齐 [待定] 项。

## Store Listing

**Extension Name** [REQUIRED]

视频录音转文字 video2srt（与 manifest.json `name` 一致）

**Short Description** [REQUIRED]

一键录制任意网页视频的音频（B 站、腾讯视频、视频号网页版等都支持），导出 MP3 并生成带时间戳的 SRT 字幕；面板固定在侧边栏，结果实时滚动显示，快捷键可自定义。（≤132 字符）

**Detailed Description** [REQUIRED]

把正在播放的视频声音变成字幕文件。在播放视频的标签页上点一下「开始」，播完点「结束」，扩展自动完成录音、保存 MP3，并调用你自己配置的转写服务生成带时间轴的 SRT 字幕，两个文件直接下载到本地「视频转写」文件夹。

主要功能：
任意网页视频都能录（B 站、腾讯视频、视频号网页版、在线课程等），录的是标签页正在播放的声音
控制面板固定在浏览器侧边栏，始终可见，点工具栏图标即开关
转写结果在面板里实时滚动显示（逐段出现），可直接编辑后一键复制 SRT 或纯文字，也可随时点「保存 MP3/SRT」弹框保存两个文件（SRT 保存编辑后的内容）
可选「结束后自动弹保存框保存 MP3/SRT」；不开启则不自动写盘，完全由你在面板里手动保存
支持键盘快捷键开始和结束，按键可在扩展快捷键页自定义；页面右键菜单也能开始/结束
自动点击视频贴片广告的「跳过广告」按钮（仅站点自己提供按钮的广告，可在设置关闭）
导出体积小巧的 MP3（16 kHz 单声道，可选码率）
接入你自己的转写服务（OpenAI 兼容接口）生成 SRT 字幕
字幕时间轴自动对齐视频内位置；模型不支持分段时间戳时自动细分转写保证精度
长音频自动分段转写再合并；播放倍速自动回到 1x，保证字幕时间准确

使用步骤：打开并播放视频 → 按开始快捷键、页面右键菜单或侧边栏面板开始录制 → 播完点「结束」→ 到下载目录取 MP3 和 SRT。

隐私说明：不收集任何个人数据，不内置任何云端服务；转写功能只在你自己填写 API 地址和 Key 后启用，音频只发往你配置的服务，Key 只保存在本机浏览器里。

支持与反馈：见下方 Support 信息。

**Category** [REQUIRED]

Productivity

**Single Purpose** [REQUIRED]

录制当前标签页播放的音频并转为 MP3 与 SRT 字幕文件。

**Primary Language** [REQUIRED]

Chinese (Simplified)

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 或 640×400 | ⬜ Not created | 建议截「录制中」侧边栏面板 + 视频页 |
| Screenshot 2 [RECOMMENDED] | 1280×800 或 640×400 | ⬜ Not created | 建议截「✓ 完成」状态 + 下载目录文件 |
| Screenshot 3 [RECOMMENDED] | 1280×800 或 640×400 | ⬜ Not created | 建议截设置页 |
| Screenshot 4 | 1280×800 或 640×400 | ⬜ Not created | |
| Screenshot 5 | 1280×800 或 640×400 | ⬜ Not created | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | |

### Screenshot Notes

2026-11-06 真机实测已产出弹窗各状态的真实截图素材（录制中/完成态），但尺寸为弹窗原始大小，需重制为 1280×800 场景图后方可提交。

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| tabCapture | permissions | 核心功能：捕获当前标签页正在播放的音频用于录音。不读取页面内容，只取声音流。 |
| offscreen | permissions | 核心功能：在后台文档中完成音频录制与 MP3 编码，避免占用用户可见页面。 |
| downloads | permissions | 把生成的 MP3 和 SRT 文件自动保存到用户下载目录的「视频转写」子文件夹。 |
| storage | permissions | 在本机保存用户的转写 API 配置（地址/模型/码率/倍速等）。API Key 只存本机，不上传。 |
| scripting | permissions | 录制开始时在目标页面读取视频标题与播放进度，用于文件命名和字幕时间轴对齐；内容脚本未覆盖页面的兜底方案。 |
| sidePanel | permissions | 唯一控制面板以浏览器侧边栏形式常驻（始终可见、可随时收起），替代网页内悬浮元素，不遮挡视频画面。 |
| contextMenus | permissions | 在页面右键菜单提供「开始/结束录制」入口；该点击同时构成 Chrome 要求的标签页捕获授权（与快捷键等价）。不读取页面内容。 |
| commands | permissions（manifest 声明） | 提供键盘快捷键：默认 Alt+Q 开关面板、Alt+S 开始录制、Alt+E 结束，用户可在 chrome://extensions/shortcuts 自定义。 |
| content_scripts 匹配所有 http(s) 网站 + `<all_urls>` host 权限 | host_permissions | 在用户观看视频的任意网页读取视频标题与播放进度（用于文件命名和字幕时间轴对齐）、把倍速强制回 1x（保证时间轴准确）、监听播放结束（可选自动停止）。内容脚本不显示任何界面。扩展不收集浏览数据。 |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No（扩展自身不收集、不上报任何数据）

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | — | — | — |
| Health info | No | — | — | — |
| Financial info | No | — | — | — |
| Authentication info | No（API Key 仅存本机 chrome.storage.local，由用户自行填入） | 仅当用户启用转写：用户自己的 API | 使用用户自配的转写服务 | 否（仅用户配置的服务端） |
| Personal communications | No | — | — | — |
| Location | No | — | — | — |
| Web history | No | — | — | — |
| User activity | No | — | — | — |
| Website content | 部分（录制时读取当前页视频标题用于文件命名；音频流即页面声音） | 音频仅发往用户自行配置的转写 API | 生成字幕 | 否 |

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]

草稿已就绪：仓库 `docs/privacy.md`（内容与下方数据披露一致：不收集个人数据、配置与录音仅存本机、音频仅发往用户自行配置的转写 API、API Key 不出本机）。

**待老金操作**：仓库 Settings → Pages → Deploy from a branch → 选 `main` + `/docs` 目录，启用后 URL 为 `https://jsy96.github.io/video2srt/privacy`，把它填进这里和开发者后台。提交前把 `docs/privacy.md` 末尾的联系邮箱占位符换成真实邮箱。

## Distribution

**Visibility**: [待定] Public（建议）
**Regions**: All regions

## 打包

提交用 zip 由 `tools/package.sh` 生成（显式白名单打包，自动排除 CHROMEWEBSTORE.md/tests/tools；PowerShell Compress-Archive，无需 zip CLI）：

```bash
cd video2srt && bash tools/package.sh   # 产出 ../video2srt-v<版本>.zip
```

当前已产出 `video2srt-v1.0.261106.5.zip`（80 KB / 15 个文件，条目分隔符与完整性已验证）。zip 为构建产物不入库（.gitignore 已排除 *.zip）。

## Developer Info

**Publisher Name** [REQUIRED]

[待定]

**Contact Email** [REQUIRED]

[待定]

**Support URL / Email** [RECOMMENDED]

[待定]

**Homepage URL** [RECOMMENDED]

[待定]

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.261106.11 | 2026-11-06 | 实时转写 PCM 抽头迁移 AudioWorklet（消除 ScriptProcessorNode 废弃告警），老环境自动退回 | Draft（未提交） |
| 1.0.261106.10 | 2026-11-06 | 边录边转：录制期间每 ~25s 切段即时转写，识别结果在面板实时逐段出现；停止后补转尾巴汇总；快捷键默认值改为 Alt+Q/S/E；结果区按钮改品牌色样式 | Draft（未提交） |
| 1.0.261106.9 | 2026-11-06 | 保存模式定稿：单一开关「结束后自动弹框保存 MP3/SRT」（默认关）；不开启则不自动写盘，录完在面板点「保存 MP3/SRT」手动弹框保存两个文件 | Draft（未提交） |
| 1.0.261106.8 | 2026-11-06 | 新增「结束后弹框保存 MP3/SRT」两个设置开关；面板新增「保存 MP3/SRT」按钮（MP3 取最近录制暂存、SRT 保存编辑框当前内容，产物暂存 IndexedDB）；修结果清空后按钮未复位 | Draft（未提交） |
| 1.0.261106.7 | 2026-11-06 | 面板布局改为撑满侧栏全高（flex），识别结果编辑框占据剩余全部高度 | Draft（未提交） |
| 1.0.261106.6 | 2026-11-06 | 侧边栏面板新增识别结果区：转写时逐段实时滚动显示，可编辑后「复制 SRT / 仅复制文字」；修复录制期间听不到声音（tabCapture 会静音标签页，按官方示例在 offscreen 回放捕获流）；文案明确为任意网页视频可录 | Draft（未提交） |
| 1.0.261106.5 | 2026-11-06 | 修复侧边栏点「开始」无反馈（错误被 render 覆盖 + tabCapture 按页授权未取得时的引导不清）；新增页面右键菜单开始/结束（构成捕获授权）；新增自动点击「跳过广告」按钮（可关） | Draft（未提交） |
| 1.0.261106.4 | 2026-11-06 | 移除网页悬浮面板（含可折叠圆钮）；控制面板由工具栏弹窗改为浏览器侧边栏（chrome.sidePanel，点图标开关、始终可见）；同步移除「显示悬浮面板」设置项与面板状态推送通道 | Draft（未提交） |
| 1.0.261106.3 | 2026-11-06 | 改名「视频录音转文字」；新增网页悬浮开始/结束面板（可拖动/折叠/全屏可见/可关闭）；新增可自定义键盘快捷键；SRT 时间轴改「探测段+细分」策略提升精度；下载目录改为「视频转写」 | Draft（未提交） |
| 1.0.261106.2 | 2026-11-06 | 修复：SRT 下载 MIME 由 text/plain 改为 application/x-subrip，防止 Chrome 把 .srt 改名 .txt（真机验证）；完成真机端到端实测 | Draft（未提交） |
| 1.0.261106.1 | 2026-11-06 | 初始实现：录制/MP3/SRT/分段转写/自动下载 | Draft（未提交） |

## Review Notes

### Known Issues / Limitations

- 实时录制：音频靠播放过程同步捕获，N 分钟视频需录 N 分钟
- 录到的是整个标签页声音（含页面内广告/弹幕音效）
- siliconflow SenseVoiceSmall 实测不返回分段时间戳，SRT 时间轴为按句均分估算（文字准确、时间近似）；whisper 系模型待验证
- 未配置转写 API 时只导出 MP3
- SRT 时间轴依赖录制期间不拖动进度条

### Rejection History

（暂无提交记录）
