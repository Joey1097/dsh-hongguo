# dsh-hongguo

摸鱼短剧：一个 DSH 插件，在右侧边栏里播一部短剧，Agent 干活的时候提示你把它调出来。

数据来自 [openhongguo](https://github.com/beilunyang/openhongguo)（第三方短剧平台的非官方 SDK，匿名设备、无需登录）。请仅用于个人学习与研究，内容版权归权利人所有。

## 截图

**剧集列表**：顶部推荐一部没看过的热门剧，下面每页 12 部，`换一批` 翻页；`观看历史` 点开才显示。

![剧集列表](docs/home.png)

**播放器**：画面按视频比例自适应，画面内控制条（进度拖动、下一集、倍速、静音、全屏），选集按 50 集分段。

![播放器](docs/player.png)

**等待提示**：Agent 运行时在输入框上方出现，点剧名直接开播，`更多…` 打开播放器。

![等待提示](docs/prompt.png)

## 功能

| 位置 | 内容 |
|---|---|
| 右侧边栏 | `摸鱼短剧` 标签页：推荐卡片 + 剧集列表（带封面、可搜索）→ 分集 → 播放器 |
| 剧集列表 | 按面板宽度自适应：每行 6 / 4 / 3 / 2 部，每页 12 部，`换一批` 翻到下一页 |
| 播放历史 | 记住每部剧看到第几集、第几秒；`观看历史` 按钮点开后一键续播，可单条移除 |
| 播放器 | 画面内控制条、倍速（1–2×）、全屏、自动连播下一集、续播提示 |
| 左侧栏底部 | `短剧` 按钮，一键打开播放器 |
| 输入框上方 | Agent 运行时出现浮框：3 部剧可直接点开，`更多…` 打开播放器；当前页面已显示播放器时不出现 |
| 任务完成 | Agent 从运行变为空闲时自动暂停正在播放的短剧，并在画面上提示 |
| 侧边栏引导页 | 一个 `摸鱼短剧` 入口卡片 |

## 结构

- **Host 半（`index.js`）**：加载 openhongguo SDK、维护匿名设备档案，提供同源路由 `/api/hongguo/{feed,series,play,media,stream,playlist,config,running,activity}`、`/api/hongguo/cover` 与 `/api/hongguo/vendor`。启动时预先拉取剧集列表。CDN 只提供 HEIC 封面，Host 用 macOS 的 `sips` 转成 JPEG 并缓存。
- **Client 半（`client.js`）**：注册侧边栏标签页类型 `hongguo`、侧栏底部按钮，以及 `conversation.input.dock` 里的等待提示。

## 播放与解密

视频是 CENC（cenc-aes-ctr）加密的 HEVC，浏览器无法直接解码。Host 用 SDK 解析出的内容密钥调用本机 `ffmpeg` 解密并重封装为普通 MP4（`-c copy`，不重编码），缓存在插件数据目录 `media/`（保留最近 40 集）。页面只拿到同源 `/api/hongguo/media` 地址，密钥不出 Host。

需要安装 ffmpeg：`brew install ffmpeg`。

## 配置

`cordis.patch.yml` 中 `hongguo` 行的 `config`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoPrompt` | `true` | Agent 运行时是否显示提示 |
| `panelWidth` | `480` | 保留字段：右侧边栏宽度由 DSH 自己管理，当前版本不生效 |
| `profilePath` | 插件数据目录 | 匿名设备档案文件；删除即更换设备 |
| `searchTerms` | `总裁/重生/逆袭` | 推荐不足时补充列表用的搜索词 |

## 本 fork 的改动

在 `frostming/dsh-hongguo` 基础上的加固与修复：

**安全**

- `/api/hongguo/*` 是绕过 DSH 认证 `/api` 桥的裸前缀路由，现在要求 `Host` 头指向本机服务本身（含 `127.0.0.1` / `localhost` / `[::1]` 别名）。DNS rebinding 的页面无法伪造该头。
- `/stream` 不再回 `Access-Control-Allow-Origin: *`；转发上游 `Content-Type` 前先过滤，非媒体类型一律降级为 `application/octet-stream` 并加 `Content-Disposition: attachment`，同时补 `X-Content-Type-Options: nosniff`，避免把 CDN 内容当同源文档执行。
- `/stream`、`/cover`、HLS/DASH 子清单、以及解密下载都重新校验跳转后的域名，不再只信任第一个 URL 的白名单结论。
- `/config` 不再返回 `profilePath` 绝对路径。
- `sips` 增加 15s 超时；封面缓存上限 300 张；ffmpeg 并发上限 2。

**功能修复**

- `/playlist` 修复：缓存里存的是 `{body,type}`，旧代码读 `entry.url` 导致每次必失败。
- `.mjs` 按 `text/javascript` 返回：Chromium 拒绝非 JS MIME 的动态 `import()`，DASH 因此永远加载不了。
- HLS 分支引用了未定义的 `onMediaError`，改为已有的 `failOnMedia`；DASH 用不存在的 `MediaPlayer.isSupported` 做前置检查，改为判断 `MediaSource` 是否存在。
- `autoPrompt` 现在真的生效（客户端读取 `/config` 后决定是否渲染等待提示）。
- 新增 `POST /api/hongguo/activity`，客户端的上报不再 404。
- 数据目录支持 `$DSH_HOME`（原先硬编码 `~/.dsh`）。

已知限制：`panelWidth` 无公开 API 可设（侧边栏自己管宽度）；`/media`、`/stream` 等路由本身仍需登录校验，仅靠 Host 头与 loopback 绑定防护，请勿把 DSH 暴露到局域网或反代出去。
