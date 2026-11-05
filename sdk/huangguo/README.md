# huangguo（黄果短剧 API 客户端）

从 APK `hgdj22.0.0.apk`（包名 `com.hg2.two_zero_one`，versionName `2.0.1`）逆向出的非官方客户端，
能力与 openhongguo 类似：浏览目录、搜索、取分集、解析播放地址。

> 仅用于个人学习与研究。内容版权归权利人所有，请遵守当地法律法规与目标站点条款。

## 快速上手

```js
import { createClient } from './index.js';

const client = await createClient();

// 首页模块
const modules = await client.modules();
console.log(modules.map((m) => `${m.id} ${m.moduleName}`));

// 某个模块的一页
const page = await client.discover({ moduleId: modules[0].id, pageSize: 12 });
console.log(page.items.map((item) => item.title));

// 搜索
const { items } = await client.search('寡妇', { pageSize: 12 });

// 分集
const episodes = await client.listEpisodes(items[0].id, { pageSize: 50 });
const free = episodes.items.find((episode) => episode.videoUrl);

// 播放：m3u8 地址 + AES-128 密钥 + 分片
const playback = await client.resolvePlayback(free);
console.log(playback.playlistURL, playback.key, playback.segments.length);

// 筛全集免费的剧（每部剧要查一次分集列表，别一次扫太多）
const freeSeries = await client.listFreeSeries({ limit: 10, pages: 1 });
console.log(freeSeries.items.map((item) => `${item.title} ${item.freeEpisodes}/${item.totalEpisodes}`));
```

命令行：

```sh
node cli.js modules
node cli.js home 0
node cli.js search 寡妇
node cli.js free 10
node cli.js play 6aa904e52dfb04df318357f5 1
```

## 方法

| 方法 | 说明 |
|---|---|
| `modules()` | 首页模块（`moduleId`、`moduleName`） |
| `discover({moduleId,pageNumber,pageSize})` | 模块内容：`banners` + `items` + `hasMore` |
| `feed({pageSize})` | 推荐流 |
| `search(keyword,{kind,pageNumber,pageSize,sortType})` | 搜索；`kind=4` 为真人短剧 |
| `getMedia(id)` | 短剧详情 |
| `listEpisodes(mediaId,{pageNumber,pageSize,sortType})` | 分集列表；每集带相对 `videoUrl` |
| `getEpisode(episodeId)` | 单集播放信息 |
| `resolvePlayback(episodeOrId)` | 播放列表、密钥、分片；付费集抛 `PAY_REQUIRED` |
| `episodeStats(mediaId)` | 分集统计：`total/free/paid/fullyFree` |
| `isFullyFree(mediaId)` | 是否全集免费（结果缓存在 client 内） |
| `listFreeSeries({limit,pages,moduleIds,maxScan,concurrency,onScan})` | 从首页模块里筛出全集免费的剧；`limit` 命中即停，`maxScan` 限制扫描量 |
| `coverURL(path)` | 相对封面路径转完整地址 |

## 认证与设备档案

`createClient()` 首次运行会注册一台匿名设备（`devID` + `devToken`）调用 `/mine/login` 换 `token`，
之后把 `devID` 和 `token` 保存到 `~/.config/huangguo/profile.json`（权限 0600；`HG_CONFIG_DIR` 可改目录）。
token 失效（`5005`/`5009`）时自动重新登录一次。

登录接口有限流（`4007 登录过于频繁`），所以不要每次调用都新建设备；复用档案即可。

## 播放

分集返回的 `videoUrl` 是相对路径。播放列表地址：

```
https://6cc2n.com/api/app/vid/h5/m3u8/<videoUrl>?token=<token>
```

返回标准 HLS，`#EXT-X-KEY` 指向 `/api/app/vid/sec`（16 字节 AES-128 密钥），
分片是 CDN 上的绝对地址，可直接播放或下载。

## 目录结构

```
index.js   客户端（签名、解密、登录、接口）
cli.js     命令行示例
```

实现细节与逆向过程见 [`reverse-engineering.md`](reverse-engineering.md)。
