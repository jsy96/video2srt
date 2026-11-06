# ai-money / help 工作区

「AI 赚钱」方向的实验项目工作区。当前包含第一个项目：**video2srt（视频号录音转写浏览器插件）**。

## 更新记录

- **2026-11-06　v1.0.261106-2　真机端到端实测通过 + 修复 SRT 扩展名被改**
  - 在真实 Chrome 156（经 `chrome://inspect/#remote-debugging` 开远程调试 + chrome-devtools MCP autoConnect）完成端到端实测：本地 TTS 中文语音视频 → tabCapture 录制 → 16 kHz 单声道 MP3 → 硅基流动 SenseVoice 转写 → SRT/MP3 双文件自动下载；状态机流转、offscreen 自动回收、SW 控制台零报错
  - 修复 bug：SRT 以 `text/plain` MIME 下载时，Chrome 下载子系统会把 `.srt` 擅自改名 `.txt`（真机复现；实测对比 `text/plain`→被改 `.txt`、`application/x-subrip`/`application/octet-stream`→保留 `.srt`）；已改用 SRT 注册 MIME `application/x-subrip` 并复测通过
  - 实测结论：siliconflow `FunAudioLLM/SenseVoiceSmall` 忽略 `verbose_json` 只回纯文本 → SRT 时间轴走均分估算兜底（文字内容准确、时间为近似值）；要精确分段需换支持 segments 的模型（如 whisper-large-v3，待验证）
  - 顺带验证：chrome:// 内部页拒录防护生效、静音录音检测报错清晰、停止时机精确（10.0 s 录制 → 9.936 s MP3）、popup 录制中/完成态渲染与版本号显示正确
- **2026-11-06　工具链配置（不涉及扩展代码）**
  - 按 Chrome 官方《Build extensions with AI coding agents》指南配置：`chrome-devtools` MCP server（`.mcp.json`，带 `--categoryExtensions --autoConnect`，可在真实 Chrome 里安装/重载/调试扩展）
  - 安装 Modern Web Guidance 技能包（`.agents/skills/`：`chrome-extensions` + `modern-web-guidance`，Claude Code 经 `.claude/skills` 链接加载；更新用 `npx modern-web-guidance@latest update`）
  - 新增项目级 `CLAUDE.md`（含 CHROMEWEBSTORE.md 维护指令）
  - 安全处理：老金本机打包产生的 `video2srt.crx`/`video2srt.pem`（打包私钥）曾被误 `git add -A` 加入提交，已在推送前拦截、从提交中移除并 gitignore；**该私钥从未上传到 GitHub**（已核实远程历史）
  - 本仓库 git 对 github.com 固定走本地代理 `127.0.0.1:7890`（直连 443 经常不通）
- **2026-11-06　v1.0.261106-1　video2srt 初始实现**
  - Chrome 扩展（Manifest V3）：一键录制当前标签页正在播放的视频号音频
  - 导出 MP3（16 kHz 单声道，lamejs 编码，可选 32/48/64 kbps）
  - 调用 OpenAI 兼容转写 API 生成 SRT 字幕（带分段时间戳；API 只回纯文本时按句估算时间轴）
  - MP3 + SRT 自动下载到「下载/视频号转写/」目录，SRT 自带 UTF-8 BOM（Windows 播放器不乱码）
  - 长音频在静音处自动分段转写再合并；录制起点在视频中途时 SRT 时间轴自动平移对齐
  - 纯函数工具库 `offscreen/core.js` 附 9 组 Node 单元测试，全部通过
  - 验证状态：语法检查 + 单元测试通过；**端到端（在真实 Chrome 里加载并录制视频号）尚未验证**，待老金本地实测

---

## video2srt 项目说明

### 功能

1. 在视频号网页（channels.weixin.qq.com，需扫码登录）或任意有视频的网页标签页上，点击扩展图标 → 「开始录制当前标签页」
2. 插件通过 Chrome `tabCapture` 捕获该标签页的音频（与正常外放同时进行，不影响观看）
3. 播放完毕点「停止并生成文件」，自动完成：解码 → 16 kHz 单声道重采样 → MP3 编码 → 转写 → SRT 生成 → 下载
4. 文件落在系统「下载」目录的 `视频号转写/` 子文件夹，命名 `视频标题_YYYYMMDD-HHMMSS.mp3/.srt`

### 目录结构

```
help/
├── README.md                 本说明文档
└── video2srt/                Chrome 扩展项目根（在 chrome://extensions 加载这个文件夹）
    ├── manifest.json         MV3 清单（版本号唯一来源，当前 1.0.261106.2）
    ├── background.js         Service Worker：状态机、tabCapture 授权、offscreen 生命周期、兜底下载
    ├── ui.css                popup 与选项页共享样式
    ├── content/content.js    视频号页面内容脚本：标题/播放进度读取、强制 1x、ended 监听
    ├── popup/                弹窗（开始/停止、实时状态、版本号显示）
    ├── options/              设置页（API 配置、码率、分段、倍速等）
    ├── offscreen/
    │   ├── offscreen.html/js offscreen 文档：录制、MP3 编码、调转写 API、SRT 生成、下载
    │   ├── core.js           纯函数工具集（SRT 时间轴、静音切点、文件名清理等，Node 可测）
    │   └── lame.min.js       lamejs 1.2.0（MP3 编码器，MIT/LGPL，本地打包）
    ├── icons/                扩展图标（16/48/128，tools/gen_icons.py 生成）
    ├── tools/gen_icons.py    图标生成脚本（uv run --no-project --with pillow tools/gen_icons.py）
    └── tests/core.test.js    单元测试（node tests/core.test.js）
```

### 安装（本地加载，无需上架）

1. Chrome 地址栏输入 `chrome://extensions`，右上角打开「开发者模式」
2. 点「加载已解压的扩展程序」，选择 `video2srt` 文件夹
3. 工具栏固定该扩展图标

### 配置转写 API（可选；不配则只导出 MP3）

1. 右键扩展图标 → 选项（或弹窗里点「转写 API 设置」）
2. 填写 OpenAI 兼容的语音转写服务，默认按硅基流动（siliconflow.cn）预填：
   - **API Base URL**：`https://api.siliconflow.cn/v1`（自建网关就填自己的地址）
   - **API Key**：你的 key（只存本机浏览器 `chrome.storage.local`，不进代码、不会被提交）
   - **模型名**：以服务商模型列表为准，例如 `FunAudioLLM/SenseVoiceSmall`（便宜快）或 `openai/whisper-large-v3`
3. 点「测试连接」确认通了，再「保存」

接口要求：兼容 OpenAI `POST /audio/transcriptions`。返回 `verbose_json`（带 segments 时间戳）→ 精确 SRT；只返回纯文本 → 自动按句切分并按时长估算时间轴。

### 使用方法

1. 打开并登录视频号网页版，播放目标视频
2. 点扩展图标 → 「开始录制当前标签页」（默认会把倍速强制回 1x，保证时间轴正确）
3. 让视频播完（**中途不要拖进度条**，拖动会导致 SRT 时间轴错位）
4. 点「停止并生成文件」，等状态变为「✓ 完成」，去下载目录的 `视频号转写/` 取文件

### 工作原理

```
popup(开始) → background:
  ├─ chrome.tabCapture.getMediaStreamId（点击扩展的手势授权）
  ├─ 创建 offscreen 文档（USER_MEDIA）
  └─ 内容脚本/executeScript 读取视频标题与当前进度
offscreen:
  ├─ getUserMedia(tab 捕获流) → 16kHz 单声道音频图 → MediaRecorder(webm/opus)
  ├─ 停止后：decodeAudioData → OfflineAudioContext 重采样 → lamejs 编码 MP3
  ├─ (可选) 按静音点分段 → 逐段 POST /audio/transcriptions → 合并 segments
  ├─ 生成 SRT（时间戳平移到视频内位置，BOM 头）
  └─ chrome.downloads 下载 → 完成后通知 background 关闭 offscreen
```

### 已验证 / 未验证（诚实声明）

已验证：
- 全部 JS 通过 `node --check` 语法检查
- `offscreen/core.js` 9 组单元测试全部通过（时间戳换算、SRT 生成、静音切点、文件名清理等）
- manifest.json 为合法 JSON；lame.min.js 为官方 lamejs 1.2.0（jsdelivr 下载，156,105 字节，含 Mp3Encoder）
- 图标为真实生成的 PNG
- **真机端到端（2026-11-06，Chrome 156 + chrome-devtools MCP）**：本地 TTS 中文语音视频页实测，tabCapture 捕获 → 16 kHz 单声道 MP3（9.94 s 对应 10 s 录制，时码精确）→ 硅基流动 SenseVoice 真实转写（中文内容准确）→ 带 BOM 的 SRT + MP3 双文件自动下载到「下载/视频号转写/」；静音检测、chrome:// 页拒录防护、popup 全状态渲染、offscreen 自动回收均正常

**未验证：**
- 视频号（channels.weixin.qq.com）真实页面（需扫码登录；捕获/转写/下载链路已由等价的普通 HTTP 视频页验证，剩余风险仅视频号页面自身的视频元素探测）
- 转写服务商对 `verbose_json` 的支持面（已实测 siliconflow SenseVoiceSmall **不支持**、只回纯文本走估算时间轴；whisper-large-v3 等支持 segments 的模型待验证）

### 已知限制

- **实时录制**：音频靠播放过程捕获，5 分钟视频就要录 5 分钟（这是绕开视频号加密流最稳的路子）
- 捕获的是整个标签页的声音：页面里混入的广告、弹幕音效也会被录进去
- 录制中拖动进度条/切换视频会使 SRT 时间轴错位（MP3 内容不受影响）
- 视频号自动连播：会连着录下一个视频，录单个视频请手动停止（或开启「播放结束自动停止」，二者按需取舍）
- 超长音频上限约 2 小时（16 kHz 单声道解码内存所限）
- 未配置转写 API 时只导出 MP3，SRT 不生成

### 常见问题

- **录出来全是静音/报「几乎全是静音」**：确认视频没静音、标签页确实在出声；确认用的是普通网页标签页
- **「已在录制中」但没在录**：弹窗点「强制结束」复位状态
- **转写失败但 MP3 正常**：弹窗会显示 API 报错原因（401=key 错，4xx=模型名/参数，网络错=代理）；MP3 已下载，可手动转写
- **SRT 时间和视频对不上**：录制起点不在视频开头会有固定偏移（插件会自动平移）；录制中拖过进度条则无法对齐，重录即可

### 安全说明

- API Key 只存浏览器本地 `chrome.storage.local`，不写入任何代码文件，仓库中无密钥
- 音频只发往你自己配置的转写 API 地址，无其它上报

### 开发与测试

```bash
cd video2srt
node tests/core.test.js                            # 单元测试
for f in background.js offscreen/*.js popup/*.js options/*.js content/*.js; do node --check $f; done
uv run --no-project --with pillow tools/gen_icons.py  # 重新生成图标
```

改完代码记得同步更新本 README 的更新记录，并递增 manifest.json 版本号（格式 `主.次.YYMMDD.序号`）。
