# ai-money / help 工作区

「AI 赚钱」方向的实验项目工作区。当前包含第一个项目：**video2srt（视频号录音转写浏览器插件）**。

## 更新记录

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
    ├── manifest.json         MV3 清单（版本号唯一来源，当前 1.0.261106.1）
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

**未验证（需要老金在真机 Chrome 里实测）：**
- 端到端流程：加载扩展 → 录制视频号 → 产出 MP3/SRT。我无法在本环境运行 Chrome，首次实测可能暴露问题（如 tabCapture 音频轨行为、offscreen 里 AudioContext 状态），有问题把弹窗错误信息发我即可修
- 各转写服务商对 `verbose_json` 的实际支持情况（不支持时会走估算时间轴，结果仍可用）

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
