# dsh-hongguo

红果短剧的 DSH 插件：在右侧边栏里播一部短剧，Agent 干活的时候提示你把它调出来。

数据来自 [openhongguo](https://github.com/beilunyang/openhongguo)（红果短剧的非官方 SDK，匿名设备、无需登录）。请仅用于个人学习与研究，内容版权归权利人所有。

## 功能

| 位置 | 内容 |
|---|---|
| 右侧边栏 | 新增 `红果短剧` 标签页：推荐 + 搜索列表（带封面）→ 分集 → 播放器（上/下一集、清晰度、进度、静音） |
| 播放历史 | 记住每部剧看到第几集、第几秒；列表顶部“继续观看”一键接着看，没有播放中的剧时推荐一部没看过的 |
| 左侧栏底部 | Settings 旁边的 `短剧` 按钮，一键打开播放器 |
| 输入框上方 | Agent 运行时出现居中的浮框：给出 3 部剧可直接点开，或点 `调出短剧`；播放器已经打开时不再显示；任务完成时自动暂停正在播放的短剧 |
| 侧边栏引导页 | 一个 `红果短剧` 入口卡片 |

## 结构

- **Host 半（`index.js`）**：加载 openhongguo SDK、维护匿名设备档案，提供同源路由 `/api/hongguo/{feed,series,play,config,running,stream,vendor,cover}`。播放分片经代理转发，页面只拿到同源地址；CDN 只提供 HEIC 封面，Host 用 macOS 的 `sips` 转成 JPEG 并缓存，内容密钥不会下发到页面。
- **Client 半（`client.js`）**：注册侧边栏标签页类型 `hongguo`、侧栏底部按钮，以及 `conversation.composer.dock` 里的运行提示。

## 配置

`cordis.patch.yml` 中 `hongguo` 行的 `config`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoPrompt` | `true` | Agent 运行时是否显示提示 |
| `panelWidth` | `480` | 播放器标签页的默认宽度（px） |
| `profilePath` | 插件数据目录 | 匿名设备档案文件；删除即更换设备 |
| `searchTerms` | `总裁/重生/逆袭` | 剧集列表的搜索词 |

> 视频是 CENC（cenc-aes-ctr）加密的 HEVC。Host 用 SDK 解析出的内容密钥调用本机 `ffmpeg` 解密并重封装为普通 MP4（`-c copy`，不重编码），缓存在插件数据目录 `media/`（保留最近 40 集），页面只拿到同源 `/api/hongguo/media` 地址，密钥不出 Host。需要安装 ffmpeg（`brew install ffmpeg`）。
