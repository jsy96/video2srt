# ai-money / help 工作区

「AI 赚钱」方向的实验项目工作区。当前包含第一个项目：**video2srt（视频录音转文字浏览器插件）**。

## 更新记录

- **2026-11-07　v1.0.261107-1　接入流式 ASR 引擎（FunASR 本地 / 腾讯云实时）**
  - 设置页新增「实时转写引擎」三选一：**分段转写**（默认，走转写 API）/ **FunASR 本地流式**（免费无限制、最快；填服务地址，默认 `ws://127.0.0.1:10096`，本机 Docker 跑 funasr-runtime-sdk 即可）/ **腾讯云实时识别**（每月免费 5 小时，填 AppId/SecretId/SecretKey）
  - 流式引擎工作原理：AudioWorklet 抽头的 16k PCM 实时喂 WebSocket，逐句拿结果**边录边上屏**（含进行中一句的部分文本），每句一个时间窗 → SRT 时间轴为逐句窗口，比分段估算更准；上屏延迟可达 1 秒内（取决于引擎响应）
  - FunASR 协议：官方 runtime WebSocket（config JSON + PCM 二进制帧 + `is_speaking:false` 收尾，兼容 2pass 离线纠正上一句）；腾讯云协议：HMAC-SHA1 签名 URL + PCM 帧 + `{"type":"end"}` 收尾（slice_type=2 为一句结束）
  - **健壮性**：流式引擎连不上/中途断开 → 自动退回分段转写续转（已出的句子保留）；流式引擎不占用 HTTP 转写 API（可只配引擎不配 API）；腾讯云参数不全保存时拦截提示
  - 新增 `offscreen/streaming.js`（纯 WebSocket 客户端模块，不依赖 chrome.*）
  - **真机验证**：FunASR 客户端对 Python mock 服务器全流程通过（partial→final→离线修正→正常关闭）；腾讯云签名与 Python 参考实现逐字节一致；腾讯云完整链路需老金填真实密钥后实测
  - 待老金操作：FunASR 本机部署（Docker：`modelscope/funasr-runtime-sdk` 流式镜像）或腾讯云控制台开通实时识别拿密钥

- **2026-11-06　v1.0.261106-12　实时转写切段缩短为 ~3 秒**
  - 实时段目标 25s → **3s**（静音搜索 ±1.5s、最短 2s、找不到静音 3s 硬切），检查节拍 2s → 1s：面板出字更勤（受 API 往返 ~1-2s 限制，体感约 **3-5 秒**蹦一段；要 <1s 逐字流式需换 websocket 流式 ASR 服务，OpenAI 兼容接口做不到）
  - 附带收益：纯文本模型（SenseVoice 等）的时间轴估算误差从「25s 窗内」收敛到「3s 窗内」，字幕更准；代价是 API 调用次数约为原来的 8 倍（总音频量不变，按秒计费的服务成本基本不变）
  - 录制中每段即转的失败仍只跳过该小段（数据损失 ≤3s）

- **2026-11-06　v1.0.261106-11　PCM 抽头迁移 AudioWorklet（消除废弃告警）**
  - 实时转写抽头由已废弃的 `ScriptProcessorNode` 迁移到 `AudioWorkletNode`：worklet 代码放真实文件 `offscreen/pcm-tap-worklet.js`（非 blob URL，符合 MV3 CSP），攒 4096 点发给主线程转 Int16
  - worklet 不可用的老环境自动退回 ScriptProcessor（仅此时才可能出现 deprecation 告警，功能不受影响）
  - 起因：老金在控制台看到 `The ScriptProcessorNode is deprecated` 告警

- **2026-11-06　v1.0.261106-10　边录边转：录制期间实时出字 + 快捷键默认值更新**
  - **实时转写重构**：16k 音频图并接 PCM 抽头（ScriptProcessor），录制期间每攒约 25s 在静音处切段**立即送转写**，结果实时推到面板编辑框——**录制中就能看到文字逐段出现**（此前只在停止后的分段转写阶段流式出字，短于 40s 的录音完全没有过程显示）
  - 停止时：等在途一段 → 补转尾巴（>2s 才转）→ 汇总最终 SRT；实时路径直接用抽头 PCM 编码 MP3，省一遍 webm 解码（内存峰值减半）
  - 模型能力探测 = 首个实时段的结果（whisper 系→逐句精确时间戳；SenseVoice 等→段内估算）；同时最多一段在途；单段失败跳过该段继续（全部失败按转写失败报错）
  - 回退：16k 音频图建立失败时无抽头，走原「停止后解码+分段转写」路径，仍逐段推结果
  - 快捷键默认值：**`Alt+Q` 开关面板、`Alt+S` 开始、`Alt+E` 结束**（manifest `suggested_key`，仅对新安装生效；老金本机自定义值恰好就是这三个，无变化）
  - 面板结果区三个操作按钮改品牌色描边样式（紫边、悬停填充，与开始/结束按钮主次分明）
  - 验证：语法检查 + 11 组单元测试通过；实时链路需下次真实录制体验（预计录 30s 左右即可看到第一段在录制中弹出）

- **2026-11-06　v1.0.261106-9　保存模式定稿：单一开关「结束后自动弹框保存 MP3/SRT」**
  - 上一版（-8）的两个分文件开关合并为一个 `autoSaveDialog`（默认**不勾选**）：
    - 勾选 → 结束时自动弹保存框，依次存 MP3 与 SRT（位置自选）
    - 不勾 → **不自动保存**：MP3 暂存在扩展 IndexedDB、SRT 在面板编辑框，录完点面板「保存 MP3/SRT」按钮弹框保存两个文件（SRT 保存编辑后的内容）；完成提示注明「未自动保存」
  - 手动模式产物生命周期：暂存随下一次录制自动覆盖；「清除状态」清空 SRT（MP3 暂存保留至被覆盖，不占浏览器配额外的空间）
  - offscreen 手动路径不再创建下载任务，直接报完成并带 SRT 原文；自动路径统一 `saveAs:true` 弹框（后台兜底路径同）

- **2026-11-06　v1.0.261106-8　弹框保存选项 + 面板「保存 MP3/SRT」按钮**
  - 设置页新增两个开关：**结束后弹保存框存 MP3 / 存 SRT**（默认关=直接落「下载/视频转写/」；开启后对应文件结束时弹 Save As 框选位置，MP3/SRT 独立控制；offscreen 直下与后台兜底两条下载路径同规则）
  - 面板结果区第三个按钮「**保存 MP3/SRT**」：MP3 取最近一次录制的暂存、SRT 用编辑框**当前内容**（编辑过再存也生效），均弹 Save As 框；暂存走扩展同源 IndexedDB（offscreen 完成时写入 mp3 blob 与文件名，文档关闭后仍在，下次录制自动覆盖）
  - 顺手修：结果清空后复制/保存按钮未复位禁用
  - 附注：真机确认 v5 授权修复生效（老金实际以快捷键/右键菜单开始了真实录制）；**录制进行中未重载浏览器内扩展**，磁盘代码与 zip 已更新，本轮录制结束后重载即生效
  - 验证：语法/11 组测试通过；面板三按钮与设置项真机确认；保存弹框路径待老金下次录制体验

- **2026-11-06　v1.0.261106-7　面板撑满侧栏全高，编辑框占据剩余空间**
  - `body.panel` 改 flex 纵向布局 + `height:100vh`：面板整体与浏览器侧栏等高，无整页滚动
  - 识别结果编辑框 `flex:1`（实测 770px 侧栏下编辑框 389px，旧版固定 220px；其他控件占约 380px 为其极限）
  - 真机验证：body 高=面板可视高、无页面滚动、结果区布局正常

- **2026-11-06　v1.0.261106-6　面板识别结果区（实时滚动+复制）+ 修复录制期间无声**
  - 侧边栏面板新增「识别结果」区：转写过程中**逐段实时滚动显示**（每转完一段就推送到面板，用户停在底部时自动跟到最新，主动上翻阅读时不打扰）；结果可直接编辑，配「复制 SRT」「仅复制文字」两个按钮（纯文字 = 去序号/时间戳，块内多行合并，按钮点击后显示 ✓ 已复制反馈）
  - **修复录制期间听不到声音**：tabCapture 捕获标签页后 Chrome 会把该标签页静音（声音全部进捕获流）——按官方 tab-capture 示例在 offscreen 文档里用 `Audio` 元素回放原始捕获流（录制的仍是 16k 降采样流，回放用原始流，音质不受影响、也不会回录）
  - 结果链路：offscreen 每段转完把部分 SRT 随进度消息发后台 → 存 `storage.local` `v2s_last_srt`（持久，重开面板仍在）→ 面板监听刷新；新一轮录制开始与「清除状态」时清空旧结果
  - 文案明确「任意网页视频都可录制」（B 站、腾讯视频、视频号网页版、在线课程等），视频号只作兼容示例；manifest/商店文档/面板提示同步
  - `core.js` 新增 `srtToPlain` 纯函数（带单元测试，共 11 组全过）；真机验证：注入部分结果 → 面板实时显示并自动滚动、V2S 解析正常（复制按钮的真实点击需老金体验）

- **2026-11-06　上架准备（不涉及扩展代码，版本号不变 v1.0.261106-5）**
  - 隐私政策草稿：`docs/privacy.md`（GitHub Pages 托管用；含 [待填] 邮箱占位，启用 Pages 后 URL 填入 CHROMEWEBSTORE.md 与开发者后台）
  - 打包脚本：`video2srt/tools/package.sh`（显式白名单打包 + PowerShell Compress-Archive，排除 CHROMEWEBSTORE.md/tests/tools）；已产出 `video2srt-v1.0.261106.5.zip`（80 KB / 15 文件，分隔符与完整性已用 Python zipfile 验证）；`*.zip` 入 .gitignore
  - 待老金完成：开发者账号注册（$5）、GitHub Pages 开启、1280×800 截图、开发者后台填表（内容从 CHROMEWEBSTORE.md 抄）

- **2026-11-06　v1.0.261106-5　真机定位修复「点开始没反应」+ 新增右键菜单授权入口 + 自动跳过广告**
  - **根因（真机抓到）**：tabCapture 的「扩展被调用过」授权**按标签页**发放，侧边栏面板按钮的点击**不构成授权**（实测错误原文 `Extension has not been invoked for the current page`）；而旧代码把后台返回的错误信息在 `render()` 里覆盖成空 → 用户看到的就是「没反应」，状态一直 idle → 「结束」永远灰着
  - 修复 1：面板点击处理改为 `await render()` 之后再写错误文案（第一版修复没等 async `render` 完成仍会被覆盖——真机复测抓到这个竞态并改正）
  - 修复 2：`tabs.query` 的 `currentWindow` 改 `lastFocusedWindow`（service worker 无所属窗口，后者语义可靠）
  - 新增**页面右键菜单**「🎙 开始录制本页音频 / ⏹ 停止录制并生成文件」（新增 `contextMenus` 权限）：右键菜单点击与快捷键一样构成 tabCapture 授权，且不受侧边栏全局常驻、切页后授权失效的影响；菜单开始成功后顺手展开侧边栏显示状态
  - 新增**自动点击「跳过广告」**（默认开、设置页可关）：MutationObserver 节流 300ms，精确匹配「跳过广告 / 跳过 ad / skip ad(s)」等文案，**只对站点自己提供跳过按钮的贴片广告有效**，无按钮的强制广告跳不过；真机验证注入的「跳过广告」按钮 1.5 s 内被自动点掉、「跳过引导」等相近文案不误伤
  - 真机验证（Chrome + chrome-devtools MCP 直连现场）：无授权时面板错误提示正常显示；自动跳广告正/反例通过；`manifest` JSON / `node --check` / 10 组单元测试通过
  - **待老金真人验证**：快捷键授权链路（CDP 模拟按键到不了浏览器层扩展命令，自动化测不了）——在视频页按一次开始快捷键（老金现绑定 `Alt+S`）应直接开录，侧边栏显示「● 录制中」且「结束」可点；或页面上右键点「🎙 开始录制本页音频」
  - 使用姿势说明：切到新标签页第一次录制时，三种授权方式任选——按开始快捷键 / 页面右键菜单 / `Alt+Q` 关开一次侧边栏面板后再点面板按钮；同一页面授权一次后，面板按钮即可直连

- **2026-11-06　v1.0.261106-4　只留一个控制面板：移除网页悬浮面板，popup 改为浏览器侧边栏（始终可见）**
  - 移除网页内悬浮控制面板（含可折叠紫色圆钮）及配套的「显示悬浮面板」设置项、面板状态推送/拉取通道（`panel-state` / `get-panel-state` / 状态里的 `tabId` 一并清理）；内容脚本只保留无界面职责：视频标题/进度读取、强制 1x、ended 监听
  - 工具栏弹窗（popup）改为 **Chrome 侧边栏面板**（`chrome.sidePanel`，manifest 新增 `sidePanel` 权限与 `side_panel.default_path`，`action` 去掉 `default_popup`）：后台 `setPanelBehavior({openPanelOnActionClick:true})`，点工具栏图标开关面板；打开期间常驻窗口右侧、**始终可见**、跨标签页不消失——解决 popup 点外部即关、无法固定的问题（老金需求：面板固定在侧边栏始终可见）
  - 面板功能与原 popup 完全一致：开始/结束、实时状态（`storage.session` 监听 + 500 ms 录制计时轮询）、转写 API 设置入口、快捷键入口、强制结束/清除状态、版本号显示；`popup/` 目录删除，新增 `sidepanel/`
  - `ui.css`：`body.popup{width:320px}` → `body.panel`（宽度由浏览器侧栏决定，内容自适应）
  - manifest 描述、CHROMEWEBSTORE.md（商店文案 + `sidePanel` 权限说明 + 版本历史）、本 README 同步更新
  - 验证：manifest JSON 合法、全部 JS `node --check` 通过、10 组单元测试全部通过；**侧边栏面板真机表现未实测**——老金在 `chrome://extensions` 重载扩展后点工具栏图标即可验证（更新后请刷新已打开的网页，旧悬浮面板的 DOM 会残留但按钮已失效）

- **2026-11-06　v1.0.261106-3　改名「视频录音转文字」+ 悬浮面板 + 快捷键 + 精确时间轴**
  - 改名：`视频号录音转写 video2srt` → `视频录音转文字 video2srt`（弹窗/悬浮面板/设置页/下载目录 `视频转写/` 同步）
  - 网页悬浮控制面板：所有 http(s) 页面右上方常驻「开始/结束」双按钮 + 实时状态；Shadow DOM 隔离样式，可拖动、可折叠成小圆钮（位置与折叠态记在页面 localStorage），进全屏视频时自动挂进全屏层保持可见；设置页可整体关闭
  - 键盘快捷键：默认 `Alt+Shift+S` 开始、`Alt+Shift+X` 停止并生成文件；扩展弹窗/悬浮面板/设置页均有入口跳 `chrome://extensions/shortcuts` 自定义
  - Chrome 平台限制（真机实测）：页面内按钮的点击**不构成** tabCapture 所需的「扩展调用」授权——首次在某个标签页使用时，面板「开始」会自动弹出扩展弹窗引导点一次「开始」（或直接按快捷键），该页授权后面板按钮即可直连
  - 精确时间轴：转写改为「探测段」策略——先转 ~25s 探测模型能力；返回分段时间戳（whisper 系）→ 大段转写逐句精确；只回纯文本（SenseVoice 等）→ 剩余按 ~25s 在静音处细分成段，每段文字只在自己时间窗内分配时间戳，误差从「整条录音」收敛到「单段内」
  - 扩展重载/更新后，已打开的旧标签页不会自动注入悬浮面板，刷新该页即恢复（Chrome 行为）
  - 修复顺手项：状态在别处复位后悬浮面板文案残留（面板每次动作后强制重拉状态；后台复位时清 tabId）；完成/出错后「开始」按钮恢复可用可直接录下一轮
  - 单元测试扩至 10 组（新增 `buildSrtEstimatedPieces` 多段顺序编号与段界约束）
  - **真机实测通过（Chrome 156 + MCP 驱动真实点击）**：悬浮面板注入/拖动基础/折叠逻辑/状态实时推送（录制计时、转写各阶段文案、完成态）；面板「开始」直连启动录制（同页授权过后）、「结束」停止；快捷键命令注册成功（`chrome.commands.getAll` 确认，老金已自行改键生效）；91 秒 TTS 语音实测产出 12 条字幕、每条独立时间窗、单调递增——对比旧版整条估算，误差从 ~91s 收敛到段内 ~6s
  - 环境备忘：Chrome 下载安全确认可能把扩展生成的文件拦在「保存中」（下载气泡出现「保留/丢弃」），点保留即落盘；本次真机测试中遇到一次（含 data: URL 与重发下载均被挂起），属浏览器侧安全策略，非扩展缺陷

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

1. 任意网页标签页（视频号网页版、B 站、腾讯视频……）上，通过**侧边栏面板**（点工具栏图标开关，常驻始终可见）或**快捷键**开始录制当前标签页音频
2. 插件通过 Chrome `tabCapture` 捕获该标签页的音频（与正常外放同时进行，不影响观看）
3. 播放完毕点「结束」（面板按钮或快捷键），自动完成：解码 → 16 kHz 单声道重采样 → MP3 编码 → 转写 → SRT 生成 → 下载
4. 文件落在系统「下载」目录的 `视频转写/` 子文件夹，命名 `视频标题_YYYYMMDD-HHMMSS.mp3/.srt`
5. SRT 时间轴：模型返回分段时间戳时逐句精确；纯文本模型自动 ~25s 细分段，误差收敛到单段内
6. 自动点击视频贴片广告的「跳过广告」按钮（只对站点自己提供按钮的广告有效，设置页可关）
7. 识别结果在侧边栏面板实时滚动显示（逐段出现），可编辑后一键「复制 SRT」或「仅复制文字」

### 目录结构

```
help/
├── README.md                 本说明文档
└── video2srt/                Chrome 扩展项目根（在 chrome://extensions 加载这个文件夹）
    ├── manifest.json         MV3 清单（版本号唯一来源，当前 1.0.261106.4；含 commands 快捷键、
    │                         side_panel 声明）
    ├── background.js         Service Worker：状态机、tabCapture 授权、offscreen 生命周期、兜底下载、
    │                         快捷键命令、页面右键菜单（开始/结束）、工具栏图标开关侧边栏面板
    ├── ui.css                侧边栏面板与选项页共享样式
    ├── content/content.js    内容脚本（所有 http(s) 页，无界面）：标题/播放进度读取、
    │                         强制 1x、ended 监听、自动点「跳过广告」
    ├── sidepanel/            侧边栏面板（唯一控制面板：开始/结束双按钮、实时状态、API 设置入口、
    │                         强制结束/清除状态、版本号显示；点工具栏图标开关，常驻始终可见）
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

### 配置转写 API 与实时引擎（可选；都不配则只导出 MP3）

1. 右键扩展图标 → 选项（或弹窗里点「转写 API 设置」）
2. 填写 OpenAI 兼容的语音转写服务，默认按硅基流动（siliconflow.cn）预填：
   - **API Base URL**：`https://api.siliconflow.cn/v1`（自建网关就填自己的地址）
   - **API Key**：你的 key（只存本机浏览器 `chrome.storage.local`，不进代码、不会被提交）
   - **模型名**：以服务商模型列表为准，例如 `FunAudioLLM/SenseVoiceSmall`（便宜快）或 `openai/whisper-large-v3`
3. 点「测试连接」确认通了，再「保存」

**实时转写引擎（可选升级，边录边逐句上屏、延迟 1 秒内）**：设置页「实时转写引擎」三选一——
- **FunASR 本地流式（推荐，免费无限制）**：本机 Docker 跑 FunASR runtime（流式模型 `paraformer-zh-streaming`），扩展里填 `ws://127.0.0.1:10096`；音频不出本机
- **腾讯云实时识别**：控制台开通语音识别，填 AppId/SecretId/SecretKey；每月免费 5 小时
- **分段转写（默认）**：走上面的转写 API，无需本地服务；流式引擎连不上时也自动退回此模式

接口要求：兼容 OpenAI `POST /audio/transcriptions`。返回 `verbose_json`（带 segments 时间戳）→ 精确 SRT；只返回纯文本 → 自动按句切分并按时长估算时间轴。

### 使用方法

1. 打开目标视频页并播放视频
2. 开始方式任选（同一页面授权一次后，侧边栏按钮即可直连）：
   - 快捷键（默认 `Alt+S` 开始 / `Alt+E` 结束 / `Alt+Q` 开关面板，可在 `chrome://extensions/shortcuts` 自定义）
   - 页面右键菜单「🎙 开始录制本页音频」
   - 侧边栏面板的「开始」（点工具栏图标或 `Alt+Q` 展开面板；面板常驻侧边栏，始终可见）
   注意：Chrome 规定侧边栏按钮的点击不构成捕获授权——在没授权过的页面上点面板「开始」会提示改用快捷键/右键菜单（或关开一次面板）
   默认会把倍速强制回 1x，保证时间轴正确；**录制期间识别结果就会逐段出现在面板编辑框里**（约每 3 秒一段，受 API 延迟影响体感 3-5 秒）
3. 让视频播完（**中途不要拖进度条**，拖动会导致 SRT 时间轴错位）；面板收起也不影响录制
4. 点「结束」（面板按钮或 `Alt+E`），等状态变为「✓ 完成」：
   - 勾了「结束后自动弹框保存」→ 自动弹保存框存 MP3/SRT
   - 没勾（默认）→ 点面板「保存 MP3/SRT」按钮手动保存；也可先编辑文字再复制/保存

### 工作原理

```
侧边栏面板/快捷键(开始) → background:
  ├─ chrome.tabCapture.getMediaStreamId（需扩展被「调用」过；面板按钮与快捷键均自带该标记）
  ├─ 创建 offscreen 文档（USER_MEDIA）
  ├─ 内容脚本/executeScript 读取视频标题与当前进度
  └─ 状态变化写入 storage.session，侧边栏面板实时监听刷新
offscreen:
  ├─ getUserMedia(tab 捕获流) → 16kHz 单声道音频图 → MediaRecorder(webm/opus)
  │    ├─ 捕获流同时经 Audio 元件回放（tabCapture 会静音标签页，不回放就听不到声音）
  │    └─ 音频图并接 PCM 抽头：流式引擎（FunASR/腾讯云）实时喂 WebSocket 逐句上屏；
  │       分段引擎则每 ~3s 在静音处切段即时转写 → 面板边录边出字（引擎可切换，断开自动互备）
  ├─ 停止后：等在途段 → 补转尾巴（>2s）→ 汇总 SRT；MP3 用抽头 PCM 直接 lamejs 编码
  │    （音频图不可用时回退：解码 webm 重采样，再按原「探测段+细分」策略分段转写，仍逐段推结果）
  ├─ 生成 SRT（时间戳平移到视频内位置，BOM 头）
  └─ 按保存模式：弹框保存两个文件 / 暂存（SRT 进面板与 storage，MP3 进 IndexedDB）等手动保存
```

### 已验证 / 未验证（诚实声明）

已验证：
- 全部 JS 通过 `node --check` 语法检查
- `offscreen/core.js` 9 组单元测试全部通过（时间戳换算、SRT 生成、静音切点、文件名清理等）
- manifest.json 为合法 JSON；lame.min.js 为官方 lamejs 1.2.0（jsdelivr 下载，156,105 字节，含 Mp3Encoder）
- 图标为真实生成的 PNG
- **真机端到端（2026-11-06，Chrome 156 + chrome-devtools MCP）**：本地 TTS 中文语音视频页实测，tabCapture 捕获 → 16 kHz 单声道 MP3（9.94 s 对应 10 s 录制，时码精确）→ 硅基流动 SenseVoice 真实转写（中文内容准确）→ 带 BOM 的 SRT + MP3 双文件自动下载到「下载/视频号转写/」；静音检测、chrome:// 页拒录防护、popup 全状态渲染、offscreen 自动回收均正常
- **悬浮面板 + 快捷键 + 细分时间轴（2026-11-06，v1.0.261106-3）**：面板在所有 http(s) 页注入、开始/结束真实点击全链路通、状态逐阶段实时推送（含「探测段→细分 N 段→保存」文案）；快捷键命令注册并被用户自定义改键验证；91 s 语音 → 12 条字幕独立时间窗（旧版为整条估算）

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

- **录制中把面板收起了，怎么停止**：按结束快捷键（默认 `Alt+E`，可在 `chrome://extensions/shortcuts` 查看/改键），或点工具栏图标重新展开面板点「结束」；录制本身在后台 offscreen 文档中进行，面板收起不影响
- **点「开始」提示「本页还没授权捕获」**：Chrome 的捕获授权按标签页发放，侧边栏/弹窗按钮的点击不算授权；按一次开始快捷键、页面右键点「🎙 开始录制本页音频」、或关开一次侧边栏面板（工具栏图标）即可授权并开始；同一页面之后面板按钮直连
- **自动跳广告没生效**：只对站点自己渲染了「跳过广告」按钮的贴片广告有效（等按钮出现即点）；无跳过按钮的强制广告、会员专属广告跳不过；确认设置页「自动点击跳过广告」已勾选
- **下载一直停在「保存文件中…」**：看 Chrome 下载气泡/下载页是否有「保留/丢弃」安全确认，点「保留」即落盘
- **录出来全是静音/报「几乎全是静音」**：确认视频没静音、标签页确实在出声；确认用的是普通网页标签页
- **「已在录制中」但没在录**：弹窗点「强制结束」复位状态
- **转写失败但 MP3 正常**：弹窗会显示 API 报错原因（401=key 错，4xx=模型名/参数，网络错=代理）；MP3 已下载，可手动转写
- **SRT 时间和视频对不上**：录制起点不在视频开头会有固定偏移（插件会自动平移）；录制中拖过进度条则无法对齐，重录即可；纯文本模型（SenseVoice 等）的时间轴为段内估算，要逐句精确请换 whisper 系模型

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
